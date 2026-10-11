// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, test } from "vitest";
import { DEFAULTS, parsePrefs, health, type HealthReport } from "../src/model";
import { createResult } from "../src/ui/result";

const here = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(resolve(here, "../index.html"), "utf8");
const input = { ...DEFAULTS, owner: "SHOP", tableName: "SALES" };

const report: HealthReport = {
  collectedAt: "2026-10-11 08:14:49",
  sections: [
    {
      id: "histograms", title: "Histograms", summary: "2 of 7 columns have a histogram.",
      findings: [
        { level: "bad", text: "SALE_DATE has a histogram that costs a second pass.", basis: "SQL Tuning Guide 11.3", fix: ["exec dbms_stats.set_table_prefs('SHOP','SALES','METHOD_OPT','FOR COLUMNS SIZE 1 SALE_DATE');"] },
        { level: "warn", text: "STATUS has 3 values and no histogram.", basis: "lab H2", fix: ["-- check the skew first", "select status, count(*) from SHOP.SALES group by status;"] },
        { level: "warn", text: "A second warning.", basis: "lab H3" },
      ],
      rows: { head: ["Column", "Buckets"], body: [["SALE_DATE", "254"], ["STATUS", "1"]] },
    },
    { id: "pending", title: "Pending statistics", summary: "No pending statistics.", findings: [] },
  ],
  skipped: ["indexes: index statistics were not collected"],
};

describe("health check rendering", () => {
  let result: ReturnType<typeof createResult>;
  beforeEach(() => {
    document.body.innerHTML = page.slice(page.indexOf("<body>") + 6, page.indexOf("</body>")).replace(/<script[\s\S]*?<\/script>/g, "");
    result = createResult(document);
  });
  const $ = (sel: string) => document.querySelector(sel) as HTMLElement;

  test("renders one sub-block per section, the badge, the lead and the fixes", () => {
    result.renderHealth(report, input);
    expect($("#health").hidden).toBe(false);
    expect($("#health-hint").hidden).toBe(true);
    expect(document.querySelectorAll("#health-body .hsec")).toHaveLength(2);
    expect($("#health-count").textContent).toBe("1 problem, 2 warnings");
    expect($("#health-count").className).toContain("bad");
    expect($("#health-lead").textContent).toContain("2026-10-11 08:14:49");
    expect($("#health-lead").textContent).toContain("SHOP.SALES");
    const first = document.querySelectorAll("#health-body .hsec")[0]!;
    expect(first.querySelector("h4")!.textContent).toBe("Histograms");
    expect(first.querySelectorAll(".finding")).toHaveLength(3);
    expect(first.querySelector(".finding .verdict.bad")!.textContent).toBe("Problem");
    expect(first.querySelector(".finding .basis")!.textContent).toBe("Basis: SQL Tuning Guide 11.3.");
    expect(first.querySelectorAll("table.resolved tbody tr")).toHaveLength(2);
    const code = first.querySelector("pre.sql code")!.textContent!;
    expect(code).toContain("set_table_prefs('SHOP','SALES','METHOD_OPT'");
    expect(code).toContain("group by status");
    expect(first.querySelector("pre.sql .fn")).not.toBeNull();
    expect(first.querySelector("button.copy")).not.toBeNull();
  });

  test("a section without findings still shows its summary, and no fix block or table", () => {
    result.renderHealth(report, input);
    const empty = document.querySelectorAll("#health-body .hsec")[1]!;
    expect(empty.querySelector(".hsum")!.textContent).toBe("No pending statistics.");
    expect(empty.querySelector(".finding")).toBeNull();
    expect(empty.querySelector("pre")).toBeNull();
    expect(empty.querySelector("table")).toBeNull();
  });

  test("lists what was not checked", () => {
    result.renderHealth(report, input);
    const d = $("#health-body details");
    expect(d.querySelector("summary")!.textContent).toBe("Not checked: 1 section");
    expect(d.querySelector("li")!.textContent).toContain("indexes");
  });

  test("says so in the lead when the recommended setup is on screen", () => {
    result.renderHealth(report, input, true);
    expect($("#health-lead").textContent).toContain("not the recommended setup");
  });

  test("is hidden without a report, with the hint under the findings", () => {
    result.renderHealth(report, input);
    result.renderHealth(null, input);
    expect($("#health").hidden).toBe(true);
    expect($("#health-body").children).toHaveLength(0);
    expect($("#health-hint").hidden).toBe(false);
    expect($("#health-hint").textContent).toContain("Paste the output of the current collect.sql");
  });

  test("a clean report counts as good", () => {
    result.renderHealth({ collectedAt: null, sections: [report.sections[1]!], skipped: [] }, { ...DEFAULTS });
    expect($("#health-count").textContent).toBe("no problems or warnings");
    expect($("#health-count").className).toContain("good");
    expect($("#health-lead").textContent).toBe("From collect.sql run on the pasted table.");
    expect(document.querySelector("#health-body details")).toBeNull();
  });

  test("a report without sections says nothing could be checked, not that all is well", () => {
    result.renderHealth({ collectedAt: null, sections: [], skipped: ["indexes: not collected"] }, input);
    expect($("#health-count").textContent).toBe("nothing could be checked");
    expect(document.querySelectorAll("#health-body .hsec")).toHaveLength(0);
    expect($("#health-body details")).not.toBeNull();
  });

  test("renders the report of a real collector paste without throwing", () => {
    const r = parsePrefs(readFileSync(resolve(here, "fixtures/collect-stats_lab-sales.txt"), "utf8"));
    expect(r.detail).not.toBeNull();
    result.renderHealth(health({ ...DEFAULTS, ...r.values }, r.detail!, r.provenance), { ...DEFAULTS, ...r.values });
    expect($("#health").hidden).toBe(false);
    expect($("#health-lead").textContent).toContain("STATS_LAB.SALES");
  });
});
