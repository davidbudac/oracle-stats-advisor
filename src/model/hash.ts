import { BOOLS, DEFAULTS, NAME_MAX, NUMBERS, OPTIONS, STRINGS, type Input } from "./defaults";

/** `key=value&...` for every field that differs from DEFAULTS, so a filled form can be shared. */
export function encodeInput(input: Partial<Input>): string {
  const out: string[] = [];
  for (const k of Object.keys(DEFAULTS) as (keyof Input)[]) {
    const v = input[k];
    if (v === undefined) continue;
    const s = typeof v === "boolean" ? (v ? "1" : "0") : String(v);
    const dv = DEFAULTS[k];
    const d = typeof dv === "boolean" ? (dv ? "1" : "0") : String(dv);
    if (s !== d) out.push(`${k}=${encodeURIComponent(s)}`);
  }
  return out.join("&");
}

/** The inverse of encodeInput: a partial input, unknown keys and invalid values dropped. */
export function decodeInput(hash: string | null | undefined): Partial<Input> {
  const out: Record<string, unknown> = {};
  for (const part of String(hash ?? "").replace(/^#/, "").split("&")) {
    const eq = part.indexOf("=");
    if (eq < 1) continue;
    const k = part.slice(0, eq);
    let v: string;
    try { v = decodeURIComponent(part.slice(eq + 1)); } catch { continue; }
    if (!(k in DEFAULTS)) continue;
    if ((BOOLS as readonly string[]).includes(k)) out[k] = v === "1" || v === "true";
    else if ((NUMBERS as readonly string[]).includes(k)) { if (v.trim() !== "" && Number.isFinite(Number(v))) out[k] = Number(v); }
    else if (k === "estimatePercent" || k === "callEstimatePercent") { if (v === DEFAULTS[k]) out[k] = v; else if (v.trim() !== "" && Number.isFinite(Number(v))) out[k] = Number(v); }
    else if ((STRINGS as readonly string[]).includes(k)) { const t = v.trim().slice(0, NAME_MAX); if (t) out[k] = t; }
    else if ((OPTIONS as Record<string, readonly string[]>)[k]?.includes(v)) out[k] = v;
  }
  return out as Partial<Input>;
}
