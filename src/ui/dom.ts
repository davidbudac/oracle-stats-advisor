/** Tiny DOM helpers: an element builder and a SQL highlighter. */
type Attrs = Record<string, string | number | boolean | null | undefined | ((e: Event) => void)>;
type Child = Node | string | number | null | undefined | false | Child[];

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs, children?: Child): HTMLElementTagNameMap[K];
export function el(tag: string, attrs?: Attrs, children?: Child): HTMLElement;
export function el(tag: string, attrs: Attrs = {}, children: Child = []): HTMLElement {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "text") node.textContent = String(v);
    else if (k === "html") node.innerHTML = String(v);
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  append(node, children);
  return node;
}

export function svg(tag: string, attrs: Record<string, string | number> = {}, children: (SVGElement | string)[] = []): SVGElement {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  for (const c of children) node.append(c);
  return node;
}

function append(node: Node, children: Child): void {
  if (children == null || children === false) return;
  if (Array.isArray(children)) { for (const c of children) append(node, c); return; }
  (node as ParentNode).append(children instanceof Node ? children : document.createTextNode(String(children)));
}

const SQL_KW = new Set(["select", "from", "where", "and", "or", "not", "in", "is", "null", "order", "by", "group", "having", "as", "on", "join", "left", "inner", "exec", "begin", "end", "declare", "exception", "when", "then", "else", "case", "for", "loop", "fetch", "first", "rows", "only", "desc", "asc", "nulls", "set", "with", "into", "values", "like", "between", "exists", "distinct", "count", "max", "min", "sum", "trim", "nvl", "dual", "true", "false"]);
const SQL_FN = new Set(["dbms_stats", "gather_table_stats", "set_table_prefs", "unlock_table_stats", "unlock_partition_stats", "delete_pending_stats", "report_gather_table_stats", "report_gather_auto_stats", "gather_schema_stats", "delete_table_prefs", "gather_index_stats", "lock_partition_stats"]);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function highlightSql(text: string): string {
  const re = /(--[^\n]*|\/\*[\s\S]*?\*\/)|('(?:[^']|'')*')|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][\w$#]*)|([\s\S])/g;
  let out = "";
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[1]) out += `<span class="com">${esc(m[1])}</span>`;
    else if (m[2]) out += `<span class="str">${esc(m[2])}</span>`;
    else if (m[3]) out += `<span class="num">${m[3]}</span>`;
    else if (m[4]) {
      const w = m[4].toLowerCase();
      if (SQL_KW.has(w)) out += `<span class="kw">${m[4]}</span>`;
      else if (SQL_FN.has(w)) out += `<span class="fn">${m[4]}</span>`;
      else out += m[4];
    } else out += esc(m[5] ?? "");
  }
  return out;
}

/** A copy button for a code block. */
export function copyButton(getText: () => string): HTMLButtonElement {
  const b = el("button", { type: "button", class: "btn tiny copy", text: "Copy" });
  b.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(getText()); b.textContent = "Copied"; } catch { b.textContent = "Select and copy"; }
    setTimeout(() => { b.textContent = "Copy"; }, 1500);
  });
  return b;
}
