/** Number formatting shared by the model (finding texts) and the page. */
export function fmt(n: number | null | undefined, digits = 0): string {
  if (n == null || Number.isNaN(n)) return "–";
  return Number(n).toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

/** A fraction as a percentage with sensible precision: 0.1 -> "10%", 0.014 -> "1.4%". */
export function pct(fraction: number, digits?: number): string {
  const p = fraction * 100;
  const d = digits ?? (p === 0 ? 0 : p >= 10 ? 0 : p >= 1 ? 1 : Math.min(6, Math.ceil(-Math.log10(p)) + 1));
  return `${fmt(p, d)}%`;
}

export const plural = (n: number, one: string, many = `${one}s`): string => `${fmt(n)} ${n === 1 ? one : many}`;
