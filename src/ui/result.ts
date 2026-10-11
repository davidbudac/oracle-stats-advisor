// Rendering of one outcome into the result pane.
import { fmt, plural } from "../model/format";
import type { Input } from "../model/defaults";
import { stepsOf, verifySql } from "../model/advise";
import type { Level, Outcome, Source } from "../model/types";
import type { SetupScripts } from "../model/setup";
import type { HealthReport, HealthSection } from "../model/health";
import { copyButton, el, highlightSql } from "./dom";
import { stackBar, type Segment } from "./stackbar";

const GLOBAL_LABEL: Record<Outcome["global"], string> = {
  merged: "Fresh: merged from the synopses", fullscan: "Fresh: from a scan of the whole table", sample: "Fresh: from a sampled scan of the whole table",
  untouched: "Left behind: unchanged", pending: "Pending: the published ones are unchanged", unchanged: "Unchanged", na: "Not a partitioned table: one level only",
};
const SYNOPSES_LABEL: Record<Outcome["synopsesAfter"], string> = {
  all: "One per partition, up to date", none: "None", stale: "Still there, out of step with the statistics", table: "One for the whole table only",
  partial: "Some partitions lack a current one (locked, left out, or not built yet)", na: "Not applicable",
};
const NOTES_LABEL: Record<string, string> = { INCREMENTAL: "INCREMENTAL", HYPERLOGLOG: "HYPERLOGLOG", "": "(blank)" };
const LEVEL_LABEL: Record<Level, string> = { good: "Good", warn: "Warning", bad: "Problem", info: "Note" };
const SOURCE_LABEL: Record<Source, string> = { call: "the call", preference: "a preference", default: "Oracle's default", ignored: "preference (call ignored)", job: "the job's preferences" };
const HEALTH_HINT = "Paste the output of the current collect.sql to add the health check (histograms, extended statistics, indexes, staleness forecast, gather history, pending and restorable statistics).";
const STATUS_LABEL = { does: "runs", skips: "skipped", stops: "stops", note: "then" } as const;

/** One finding as a list item: level badge, text, basis. Shared by the advice findings and the health check. */
function findingItem(f: { level: Level; text: string; basis: string }): HTMLElement {
  return el("li", { class: "finding" }, [
    el("span", { class: `verdict ${f.level}` }, LEVEL_LABEL[f.level]), " ", f.text, " ", el("small", { class: "basis" }, `Basis: ${f.basis}.`),
  ]);
}

/** "3 problems, 5 warnings", with the class of the worst level; nothing to fix reads as good. */
export function healthCount(report: HealthReport): { text: string; level: Level } {
  if (!report.sections.length) return { text: "nothing could be checked", level: "info" };
  const all = report.sections.flatMap((s) => s.findings);
  const bad = all.filter((f) => f.level === "bad").length, warn = all.filter((f) => f.level === "warn").length;
  const parts = [bad ? plural(bad, "problem") : "", warn ? plural(warn, "warning") : ""].filter(Boolean);
  return { text: parts.length ? parts.join(", ") : "no problems or warnings", level: bad ? "bad" : warn ? "warn" : "good" };
}

function healthSection(s: HealthSection): HTMLElement {
  const fixes = s.findings.flatMap((f) => f.fix ?? []);
  const fixCode = el("code", { html: highlightSql(fixes.join("\n")) });
  return el("div", { class: "hsec", "data-section": s.id }, [
    el("h4", {}, s.title),
    el("p", { class: "hsum" }, s.summary),
    s.findings.length ? el("ul", { class: "findings" }, s.findings.map(findingItem)) : null,
    s.rows && s.rows.body.length ? el("table", { class: "resolved hrows" }, [
      el("thead", {}, el("tr", {}, s.rows.head.map((h) => el("th", {}, h)))),
      el("tbody", {}, s.rows.body.map((r) => el("tr", {}, r.map((c) => el("td", {}, c))))),
    ]) : null,
    fixes.length ? el("div", { class: "hfix" }, [
      el("div", { class: "hfix-head" }, [el("span", { class: "hlabel" }, "What to change"), copyButton(() => fixCode.textContent ?? "")]),
      el("pre", { class: "sql" }, fixCode),
    ]) : null,
  ]);
}

export function createResult(root: Document | HTMLElement) {
  const $ = <T extends HTMLElement = HTMLElement>(sel: string) => root.querySelector(sel) as T;
  const nowBar = stackBar($("#bar-now"), "Blocks read by this gather");
  const nextBar = stackBar($("#bar-next"), "Blocks read by the next plain gather");
  const sqlCode = $("#sql"), fixCode = $("#fixes"), verifyCode = $("#verify");
  const setupBlock = $("#setup"), setupNote = $("#setup-note"), applyCode = $("#setup-apply"), rollbackCode = $("#setup-rollback");
  for (const code of [sqlCode, fixCode, verifyCode, applyCode, rollbackCode]) code.parentElement!.append(copyButton(() => code.textContent ?? ""));

  function segs(o: Outcome): Segment[] {
    const B = o.input.blocksPerPartition, f = o.scan.kind === "block-sample" && o.scan.percent ? o.scan.percent / 100 : 1;
    const r = o.read;
    const flat = !o.input.partitioned;
    return [
      { label: flat ? "the table" : `${fmt(r.newParts)} new`, value: Math.ceil(r.newParts * B * f), color: "new" as const },
      { label: `${fmt(r.changedParts)} changed`, value: Math.ceil(r.changedParts * B * f), color: "changed" as const },
      { label: flat ? "the table" : `${fmt(r.otherParts)} others again`, value: Math.ceil(r.otherParts * B * f), color: "other" as const },
      { label: "every partition again", value: Math.ceil(r.extraPass * B * f), color: "extra" as const },
      { label: "whole table again", value: Math.ceil(r.globalScan * B * f), color: "global" as const },
    ].filter((s) => s.value > 0);
  }
  const blocks = (x: Outcome) => (x.error ? `${x.error}` : x.blocks ? `${fmt(x.blocks)} blocks` : "0 blocks");
  const indexNote = (o: Outcome) => (o.indexes.fullScans + o.indexes.partitionScans ? `plus ${plural(o.indexes.fullScans, "full index scan")}${o.indexes.partitionScans ? ` and ${plural(o.indexes.partitionScans, "index partition")}` : ""}` : "no index work");

  function partitionMap(o: Outcome): HTMLElement {
    const c = o.cells;
    if (!o.input.partitioned) return el("div", { class: "pmap-flat" });
    const cap = 120;
    const kinds: { cls: string; n: number; read: number }[] = [
      { cls: "new", n: c.newRead + c.newLeft, read: c.newRead },
      { cls: "changed", n: c.changedRead + c.changedLeft, read: c.changedRead },
      { cls: "locked", n: c.locked, read: 0 },
      { cls: "other", n: c.otherRead + c.otherLeft, read: c.otherRead },
    ];
    const cells: HTMLElement[] = [];
    let shown = 0;
    for (const k of kinds) {
      for (let i = 0; i < k.n && shown < cap; i++, shown++) {
        const isRead = i < k.read;
        cells.push(el("span", { class: `cell ${k.cls}${isRead ? " read" : ""}${c.extraPass && isRead ? " twice" : ""}`, title: `${k.cls}${isRead ? ", read" : ", not read"}` }));
      }
    }
    const legend = el("ul", { class: "pmap-legend" }, [
      el("li", {}, [el("span", { class: "cell new read" }), ` new: ${fmt(c.newRead)} read${c.newLeft ? `, ${fmt(c.newLeft)} left` : ""}`]),
      el("li", {}, [el("span", { class: "cell changed read" }), ` changed: ${fmt(c.changedRead)} read${c.changedLeft ? `, ${fmt(c.changedLeft)} not read` : ""}`]),
      c.locked ? el("li", {}, [el("span", { class: "cell locked" }), ` locked: ${fmt(c.locked)}, never read${c.lockedChanged ? ` (${fmt(c.lockedChanged)} with DML)` : ""}`]) : null,
      el("li", {}, [el("span", { class: "cell other" }), ` unchanged: ${fmt(c.otherLeft)} not read${c.otherRead ? `, ${fmt(c.otherRead)} read again` : ""}`]),
      c.extraPass ? el("li", {}, [el("span", { class: "cell other read twice" }), " read twice (histogram pass)"]) : null,
      c.globalScan ? el("li", { class: "bad-ink" }, "then the whole table again, for the global statistics") : null,
    ]);
    return el("div", { class: "pmap-wrap" }, [
      el("div", { class: "pmap-grid", role: "img", "aria-label": `Partition map: ${fmt(o.partitionsRead)} of ${fmt(c.total)} partitions read` }, cells),
      c.total > cap ? el("p", { class: "muted small" }, `Showing ${fmt(cap)} of ${fmt(c.total)} partitions.`) : null,
      legend,
    ]);
  }

  function render(o: Outcome, clampNotes: string[], input: Input) {
    const N = input.partitions, B = input.blocksPerPartition, T = N * B;
    const nx = o.next;
    const job = input.runBy !== "call", nextRun = input.runBy === "hf" ? "high-frequency task run" : "job run";
    const total = Math.max(2 * T, o.blocks, nx?.blocks ?? 0);
    nowBar.update(segs(o), total, indexNote(o));
    nextBar.update(nx ? segs(nx) : [], total, nx ? indexNote(nx) : undefined);
    $("#bar-next-h").textContent = job ? `The next ${nextRun}` : "The next plain gather";

    $("#verdict").replaceChildren(
      el("span", { class: `verdict ${o.verdict[0]}` }, o.verdict[1]),
      el("span", { class: "verdict-sub" }, o.error ? ` ${o.error}: nothing is read.` : ` Reads ${fmt(o.blocks)} blocks now${nx ? `, ${fmt(nx.blocks)} at the next ${job ? nextRun : "plain gather"}` : ""}.`),
    );
    $("#names-note").hidden = !!(input.owner && input.tableName);
    $("#pmap").replaceChildren(partitionMap(o));

    const row = (dt: string, dd: Node | string, cls = "") => el("div", {}, [el("dt", {}, dt), el("dd", { class: cls }, dd)]);
    $("#readout").replaceChildren(
      row("Read by this gather", blocks(o), "est"),
      row(job ? `Read by the next ${nextRun}` : "Read by the next plain gather", nx ? blocks(nx) : "–"),
      input.partitioned ? row("Partitions read now", `${fmt(o.partitionsRead)} of ${fmt(N)}`) : row("Scan", o.scan.kind === "none" ? "none" : o.scan.kind === "full" ? "full, every row" : `${o.scan.kind.replace("-", " ")} ${fmt(o.scan.percent ?? 0, 6)}%`),
      input.partitioned ? row("Global statistics afterwards", GLOBAL_LABEL[o.global]) : row("NDV", o.columns.ndv.split(".")[0] ?? ""),
      input.partitioned ? row("Synopses afterwards", SYNOPSES_LABEL[o.synopsesAfter]) : row("Histograms", o.columns.kinds.length ? o.columns.kinds.map((k) => k.split(",")[0]).join(", ") : o.columns.deleted ? "deleted" : "none built"),
      row("NOTES on the column statistics", o.globalNotes == null ? "not applicable" : el("code", {}, NOTES_LABEL[o.globalNotes] ?? o.globalNotes)),
      row("Index work", o.indexes.fullScans + o.indexes.partitionScans ? `${plural(o.indexes.fullScans, "full index scan")}${o.indexes.partitionScans ? `, ${plural(o.indexes.partitionScans, "index partition")}` : ""}` : "none"),
      row("Written to", o.write.destination === "dictionary" ? "the dictionary, published" : o.write.destination === "pending" ? "the pending area" : "nothing"),
      row("Cursors", o.write.invalidation === "rolling" ? "rolling invalidation, about 5 h" : o.write.invalidation === "immediate" ? "invalidated at once" : o.write.invalidation === "never" ? "never invalidated" : "untouched"),
      row("Table-level statistics", o.auto.stale ? "missing or stale by the supplied DML counters" : "not stale by DML percentage; individual partitions may still need gathering"),
    );
    $("#tip").textContent = input.partitioned
      ? `Estimated table reads use ${fmt(B)} blocks per partition, ${fmt(T)} for the table. The model scales the 19.27 observations and assumes a row-sampled pass visits the same blocks as a full scan. Unequal partitions, histogram samples and index work can change the actual I/O; index scans are listed separately.`
      : `The table has ${fmt(B)} blocks. A row sample still visits every block; only block_sample => TRUE reads less. Index scans are listed, not added to the block count.`;

    $("#steps").replaceChildren(...stepsOf(o).map((s) => el("li", { class: `step ${s.status}` }, [
      el("div", { class: "step-head" }, [el("span", { class: `status ${s.status}` }, STATUS_LABEL[s.status]), el("strong", {}, s.title), s.reads ? el("span", { class: "reads" }, s.reads) : null]),
      el("p", {}, s.text),
      s.basis ? el("small", { class: "basis" }, `Basis: ${s.basis}.`) : null,
    ])));

    const ef = o.effective;
    const used = [`ESTIMATE_PERCENT ${ef.estimatePercent === "auto" ? "AUTO_SAMPLE_SIZE" : fmt(ef.estimatePercent, 6)}`, `METHOD_OPT ${ef.methodOpt === "auto" ? "SIZE AUTO" : ef.methodOpt === "size1" ? "SIZE 1" : ef.methodOpt === "pinned" ? "pinned list" : ef.methodOpt.toUpperCase()}`, input.partitioned ? `GRANULARITY ${ef.granularity}` : "", `CASCADE ${ef.cascade}`, `NO_INVALIDATE ${ef.noInvalidate}`, `OPTIONS ${ef.options}`].filter(Boolean);
    $("#effective").replaceChildren(el("strong", {}, "The gather used: "), `${used.join(", ")}.`, ...(ef.ignored.length ? [" ", el("strong", {}, "Ignored by the override: "), `${ef.ignored.join(", ")}.`] : []));
    $("#resolved").replaceChildren(
      el("thead", {}, el("tr", {}, [el("th", {}, "Setting"), el("th", {}, "Value used"), el("th", {}, "From")])),
      el("tbody", {}, o.resolved.map((r) => el("tr", {}, [
        el("td", {}, el("code", {}, r.param)),
        el("td", {}, el("code", {}, r.value)),
        el("td", {}, [el("span", { class: `src ${r.source}` }, SOURCE_LABEL[r.source]), r.note ? el("small", { class: "muted" }, ` ${r.note}`) : null]),
      ]))),
    );

    $("#findings").replaceChildren(...o.findings.map(findingItem));
    sqlCode.innerHTML = highlightSql(o.sql);
    const fixText = [...(o.fixes.length ? o.fixes : ["-- nothing to change"]), "", "-- reads nothing: lists what the next gather would read", o.dryRun].join("\n");
    fixCode.innerHTML = highlightSql(fixText);
    verifyCode.innerHTML = highlightSql(verifySql(o));
    const clamp = $("#clamp");
    clamp.textContent = clampNotes.join(" ");
    clamp.hidden = clampNotes.length === 0;
  }
  /**
   * Compare your setup with the recommended one, and show the apply and rollback scripts that take
   * the first to the second. `showing` marks the column of the view on screen; null hides the block.
   */
  function showCompare(c: { yours: Outcome; rec: Outcome; scripts: SetupScripts; loadedFromDb: boolean; showing: "yours" | "rec" } | null) {
    const block = $("#compare");
    block.hidden = setupBlock.hidden = !c;
    if (!c) return;
    const { yours, rec, scripts } = c;
    const n = scripts.changed.length;
    const job = yours.input.runBy !== "call", nextRun = yours.input.runBy === "hf" ? "high-frequency task run" : "job run";
    const assumesSynopses = yours.input.partitioned && yours.input.synopses !== "all";
    $("#compare-note").textContent = (n
      ? `The recommended setup changes ${n === 1 ? "one preference" : `${n} preferences`}; everything else is your setup. Switch between the two at the top of the page.`
      : "Your setup already has every preference of the recommended setup.")
      + (assumesSynopses ? " The recommended column assumes every partition has a synopsis, as after the first incremental gather." : "");
    const col = (v: "yours" | "rec") => (c.showing === v ? "on" : "");
    const row = (label: Node | string, a: Node | string, b: Node | string) => el("tr", {}, [el("th", { scope: "row" }, label), el("td", { class: col("yours") }, a), el("td", { class: col("rec") }, b)]);
    const pill = (o: Outcome) => el("span", { class: `verdict ${o.verdict[0]}` }, o.verdict[1]);
    const next = (o: Outcome) => (o.next ? blocks(o.next) : "–");
    $("#compare-table").replaceChildren(
      el("thead", {}, el("tr", {}, [el("th", {}, ""), el("th", { class: col("yours") }, "Your setup"), el("th", { class: col("rec") }, "Recommended")])),
      el("tbody", {}, [
        row("Verdict", pill(yours), pill(rec)),
        row("Read by this gather", blocks(yours), blocks(rec)),
        row(job ? `Read by the next ${nextRun}` : "Read by the next plain gather", next(yours), next(rec)),
        yours.input.partitioned ? row("Global statistics afterwards", GLOBAL_LABEL[yours.global], GLOBAL_LABEL[rec.global]) : null,
        ...scripts.diff.map((d) => row(el("code", {}, d.name), el("code", {}, d.before ?? "NULL"), el("code", {}, d.after || "NULL"))),
      ]),
    );
    setupNote.textContent = (n
      ? `Run Apply in the PDB that owns the table to set ${n === 1 ? "the one preference" : `the ${n} preferences`} that differ from the recommended setup; Roll back puts the previous ${n === 1 ? "value" : "values"} back. `
      : "The table already has the recommended preferences; there is nothing to apply or roll back. ")
      + "Both scripts start from your setup as the form describes it now"
      + (c.loadedFromDb ? ", filled from your database." : ". Fill the form from collect.sql first for the exact previous values and an exact rollback.");
    applyCode.innerHTML = highlightSql(scripts.apply);
    rollbackCode.innerHTML = highlightSql(scripts.rollback);
  }
  /**
   * The health check of the real table, from the collector's DETAIL block. null (no block pasted)
   * hides the block and shows the hint under the findings. `recommended` says the form shows the
   * recommended setup, which the report does not describe.
   */
  function renderHealth(report: HealthReport | null, input: Input, recommended = false) {
    const block = $("#health"), hint = $("#health-hint");
    hint.textContent = HEALTH_HINT;
    hint.hidden = !!report;
    block.hidden = !report;
    if (!report) { $("#health-body").replaceChildren(); return; }
    const count = healthCount(report);
    const badge = $("#health-count");
    badge.className = `verdict ${count.level}`;
    badge.textContent = count.text;
    const table = input.owner && input.tableName ? `${input.owner}.${input.tableName}` : "the pasted table";
    $("#health-lead").textContent = `From collect.sql run${report.collectedAt ? ` at ${report.collectedAt}` : ""} on ${table}.`
      + (recommended ? " This describes the table as it is now, not the recommended setup." : "");
    $("#health-body").replaceChildren(
      ...report.sections.map(healthSection),
      ...(report.skipped.length ? [el("details", { class: "deep hskipped" }, [
        el("summary", {}, `Not checked: ${plural(report.skipped.length, "section")}`),
        el("ul", {}, report.skipped.map((x) => el("li", {}, x))),
      ])] : []),
    );
  }
  return { render, showCompare, renderHealth };
}
