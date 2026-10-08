import { fmt, pct } from "../model/format";
import { el, svg } from "./dom";

export interface Segment { label: string; value: number; color: "new" | "changed" | "other" | "extra" | "global" | "index" }

/** One proportional bar of blocks with a legend under it. Same scale for every update (total). */
export function stackBar(host: HTMLElement, title: string) {
  const wrap = el("div", { class: "stackbar", role: "img", "aria-label": title });
  host.replaceChildren(wrap);
  return {
    update(segments: Segment[], total: number, note?: string) {
      const sum = segments.reduce((a, s) => a + s.value, 0);
      const W = 1000, H = 28;
      const s = svg("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", class: "stackbar-svg", "aria-hidden": "true" });
      s.append(svg("rect", { x: 0.5, y: 0.5, width: W - 1, height: H - 1, rx: 4, class: "sb-frame" }));
      let x = 0;
      const scale = Math.max(total, sum) || 1;
      for (const sg of segments) {
        if (sg.value <= 0) continue;
        const w = Math.max(3, (sg.value / scale) * W);
        s.append(svg("rect", { x, y: 0, width: w, height: H, class: `sb-seg sb-${sg.color}` }));
        x += w;
      }
      const legend = el("ul", { class: "sb-legend" }, [
        ...segments.filter((sg) => sg.value > 0).map((sg) => el("li", {}, [el("span", { class: `sw sb-${sg.color}` }), `${sg.label}: ${fmt(sg.value)} blocks (${pct(sg.value / scale)})`])),
        sum === 0 ? el("li", { class: "muted" }, "nothing read") : null,
      ]);
      const head = el("div", { class: "sb-head" }, [el("strong", {}, sum ? `${fmt(sum)} blocks` : "0 blocks"), note ? el("span", { class: "muted" }, ` · ${note}`) : null]);
      wrap.replaceChildren(head, s, legend);
    },
  };
}
