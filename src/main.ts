import "./style.css";
import { DEFAULTS, PREF_OF_FIELD, PRESETS, RECOMMENDED, STRINGS, advise, clampInput, decodeInput, encodeInput, parsePrefs, setupScripts, type Input, type Provenance } from "./model";
import { buildForm } from "./ui/form";
import { createResult } from "./ui/result";
import { el } from "./ui/dom";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

// ---- theme
{
  const KEY = "gather-advisor-theme";
  const btn = $<HTMLButtonElement>("#theme");
  const apply = (t: string | null) => {
    if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
    const dark = t === "dark" || (!t && matchMedia("(prefers-color-scheme: dark)").matches);
    btn.textContent = dark ? "Light" : "Dark";
    btn.setAttribute("aria-pressed", String(dark));
  };
  let saved: string | null = null;
  try { saved = localStorage.getItem(KEY); } catch { /* private mode */ }
  apply(saved);
  btn.addEventListener("click", () => {
    const dark = document.documentElement.dataset.theme === "dark" || (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
    const next = dark ? "light" : "dark";
    try { localStorage.setItem(KEY, next); } catch { /* ignore */ }
    apply(next);
  });
}

// ---- form and result
const keys = Object.keys(DEFAULTS) as (keyof Input)[];
let current: Input = { ...DEFAULTS };
let lastHash: string | null = null;
// what the last paste said beyond the form (exact preference texts, table-level list, histogram columns); null until a paste fills the form
let loaded: Provenance | null = null;
// "Use the recommended setup" opens a second view; the form keeps your setup and the recommended one is derived from it
let recOpen = false;
let view: "yours" | "rec" = "yours";
const recommendedOf = (i: Input) => clampInput({ ...i, ...RECOMMENDED }).input;
const result = createResult(document);
const { ctl, applyVisibility } = buildForm($("#form"), (key) => update(key));

const readState = (): Partial<Record<keyof Input, unknown>> => Object.fromEntries(keys.map((k) => [k, ctl[k] ? ctl[k]!.get() : current[k]]));
const writeState = (state: Input, raw?: Partial<Record<keyof Input, unknown>>) => {
  for (const k of keys) {
    const c = ctl[k];
    if (!c) continue;
    if (raw && (STRINGS as readonly string[]).includes(k)) continue; // the reader is typing: do not trim under the cursor
    if (raw && typeof raw[k] === "number" && Number.isFinite(raw[k] as number) && raw[k] === state[k]) continue;
    if (raw && typeof raw[k] === "number" && Number.isNaN(raw[k])) continue; // a field the reader is still typing
    c.set(state[k]);
  }
};

function render(input: Input, clampNotes: string[]) {
  current = input;
  const rec = recOpen ? recommendedOf(input) : null;
  const shown = rec && view === "rec" ? rec : input;
  applyVisibility(shown);
  const outcome = advise(shown);
  result.render(outcome, shown === input ? clampNotes : clampInput(shown).notes, shown);
  if (rec) {
    const yours = shown === input ? outcome : advise(input);
    const scripts = setupScripts(input, loaded);
    result.showCompare({ yours, rec: shown === rec ? outcome : advise(rec), scripts, loadedFromDb: loaded !== null, showing: view });
    $("#views-count").textContent = scripts.changed.length ? `· ${scripts.changed.length} changed` : "· same";
    for (const k of keys) ctl[k]?.wrap.classList.toggle("diff", input[k] !== rec[k]);
  } else result.showCompare(null);
  const hash = encodeInput(input);
  if (hash !== lastHash) {
    lastHash = hash;
    try { history.replaceState(null, "", hash ? `#${hash}` : location.pathname + location.search); } catch { /* sandboxed */ }
  }
}
function update(edited?: keyof Input) {
  const pref = edited && PREF_OF_FIELD[edited];
  if (pref && loaded) delete loaded.raw[pref]; // the reader overrode the pasted text: the form value is now the truth
  const raw = readState();
  const { input, notes } = clampInput(raw, edited);
  writeState(input, raw);
  render(input, notes);
}
function apply(partial: Partial<Input>, edited?: keyof Input) {
  if (view !== "yours") showView("yours", false);
  const { input } = clampInput({ ...current, ...partial }, edited);
  writeState(input);
  const { notes } = clampInput(input);
  render(input, notes);
}

/** Switch the form and the result between your setup and the recommended one; the form is editable only on your setup. */
function showView(v: "yours" | "rec", draw = true) {
  view = v;
  $("#view-yours").setAttribute("aria-pressed", String(v === "yours"));
  $("#view-rec").setAttribute("aria-pressed", String(v === "rec"));
  $("#view-note").hidden = v === "yours";
  $("#form").inert = v === "rec";
  $("#form").classList.toggle("is-rec", v === "rec");
  if (!draw) return;
  writeState(v === "rec" ? recommendedOf(current) : current);
  render(current, clampInput(current).notes);
}
$("#recommended").addEventListener("click", () => {
  recOpen = true;
  $("#views").hidden = false;
  showView("rec");
  $("#compare").scrollIntoView({ behavior: "smooth", block: "nearest" });
});
$("#view-yours").addEventListener("click", () => showView("yours"));
$("#view-rec").addEventListener("click", () => showView("rec"));
$("#view-back").addEventListener("click", () => showView("yours"));
$("#reset").addEventListener("click", () => { loaded = null; apply({ ...DEFAULTS, owner: current.owner, tableName: current.tableName }); });

// ---- presets
{
  const sel = $<HTMLSelectElement>("#preset");
  sel.replaceChildren(el("option", { value: "" }, "Pick one…"), ...PRESETS.map((p) => el("option", { value: p.id }, p.label)));
  sel.addEventListener("change", () => {
    const p = PRESETS.find((x) => x.id === sel.value);
    $("#preset-blurb").textContent = p ? p.blurb : "";
    if (p) { loaded = null; apply({ ...DEFAULTS, owner: current.owner, tableName: current.tableName, ...p.values }); }
  });
}

// ---- paste to prefill
{
  const paste = $<HTMLTextAreaElement>("#paste"), parsed = $("#parsed");
  $("#fill").addEventListener("click", () => {
    const r = parsePrefs(paste.value);
    if (!r.recognised.length && !r.ignored.length) { parsed.replaceChildren("Nothing to read yet. Paste the block from collect.sql, or SET_TABLE_PREFS calls, DBA_TAB_STAT_PREFS rows, NAME = VALUE lines or the GET_PREFS output."); return; }
    loaded = r.provenance;
    apply(r.values);
    parsed.replaceChildren(
      el("strong", {}, "Recognised: "), `${r.recognised.length ? r.recognised.join(", ") : "nothing"}. `,
      ...(r.ignored.length ? [el("strong", {}, "Ignored: "), `${r.ignoredDetail.map((d) => `${d.line} (${d.reason})`).join("; ")}. `] : []),
      r.notes.join(" "),
    );
  });
}

// ---- the hash carries a filled form
const fromHash = () => {
  const h = location.hash.replace(/^#/, "");
  if (h === (lastHash ?? "")) return false;
  apply({ ...DEFAULTS, ...decodeInput(h) });
  return true;
};
addEventListener("hashchange", fromHash);
writeState({ ...DEFAULTS });
if (!fromHash()) update();
