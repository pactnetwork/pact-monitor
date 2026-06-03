import { readFileSync, writeFileSync } from "node:fs";

const base = "/Users/q3labsadmin/Q3/Solder/pact-network/";
const docs = [
  { src: "docs/architecture/ARCHITECTURE.en.md", out: "docs/architecture/ARCHITECTURE.en.html", title: "Pact Network — Architecture Overview", lang: "en", kind: "arch" },
  { src: "docs/architecture/ARCHITECTURE.vi.md", out: "docs/architecture/ARCHITECTURE.vi.html", title: "Pact Network — Tổng quan Kiến trúc", lang: "vi", kind: "arch" },
  { src: "docs/architecture/DIVERGENCE-AUDIT.en.md", out: "docs/architecture/DIVERGENCE-AUDIT.en.html", title: "Pact Network — Divergence Audit", lang: "en", kind: "audit" },
  { src: "docs/architecture/DIVERGENCE-AUDIT.vi.md", out: "docs/architecture/DIVERGENCE-AUDIT.vi.html", title: "Pact Network — Kiểm toán Divergence", lang: "vi", kind: "audit" },
  { src: "docs/architecture/PACKAGE-BREAKDOWN.en.md", out: "docs/architecture/PACKAGE-BREAKDOWN.en.html", title: "Pact Network — Package Breakdown", lang: "en", kind: "pkg" },
  { src: "docs/architecture/PACKAGE-BREAKDOWN.vi.md", out: "docs/architecture/PACKAGE-BREAKDOWN.vi.html", title: "Pact Network — Phân tích Package", lang: "vi", kind: "pkg" },
];

const nav = (cur) => {
  const items = [
    { kind: "arch", lang: "en", href: "ARCHITECTURE.en.html", label: "Architecture · EN" },
    { kind: "arch", lang: "vi", href: "ARCHITECTURE.vi.html", label: "Kiến trúc · VI" },
    { kind: "audit", lang: "en", href: "DIVERGENCE-AUDIT.en.html", label: "Divergence · EN" },
    { kind: "audit", lang: "vi", href: "DIVERGENCE-AUDIT.vi.html", label: "Divergence · VI" },
    { kind: "pkg", lang: "en", href: "PACKAGE-BREAKDOWN.en.html", label: "Packages · EN" },
    { kind: "pkg", lang: "vi", href: "PACKAGE-BREAKDOWN.vi.html", label: "Packages · VI" },
  ];
  return items.map(i => `<a href="${i.href}" class="${i.kind === cur.kind && i.lang === cur.lang ? "active" : ""}">${i.label}</a>`).join("");
};

for (const d of docs) {
  const md = readFileSync(base + d.src, "utf8");
  const b64 = Buffer.from(md, "utf8").toString("base64");
  const html = `<!doctype html>
<html lang="${d.lang}">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${d.title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inria+Serif:wght@400;700&family=Inria+Sans:wght@400;700&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<style>
  :root{--bg:#151311;--panel:#1c1a17;--line:#2c2824;--ink:#e7e1d8;--muted:#a99e90;--copper:#B87333;--sienna:#C9553D;--slate:#5A6B7A;}
  *{box-sizing:border-box}
  html{scroll-behavior:smooth}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:"Inria Sans",system-ui,sans-serif;line-height:1.65;font-size:16px;-webkit-font-smoothing:antialiased}
  .wrap{max-width:980px;margin:0 auto;padding:48px 28px 120px}
  h1,h2,h3,h4{font-family:"Inria Serif",Georgia,serif;line-height:1.25;font-weight:700;color:#fff}
  h1{font-size:2.1rem;margin:.2em 0 .6em;border-bottom:2px solid var(--copper);padding-bottom:.3em}
  h2{font-size:1.5rem;margin:2em 0 .5em;color:var(--copper)}
  h3{font-size:1.18rem;margin:1.6em 0 .4em;color:var(--slate)}
  a{color:var(--copper);text-decoration:none}
  a:hover{text-decoration:underline}
  blockquote{border-left:3px solid var(--slate);margin:1em 0;padding:.4em 1em;background:var(--panel);color:var(--muted);font-size:.94em}
  code{font-family:"JetBrains Mono",monospace;font-size:.86em;background:#241f1b;color:#e8c9a6;padding:.12em .4em;border:1px solid var(--line)}
  pre{background:var(--panel);border:1px solid var(--line);padding:14px 16px;overflow:auto}
  pre code{background:none;border:none;color:#d6cfc4;padding:0}
  table{border-collapse:collapse;width:100%;margin:1.2em 0;font-size:.92em}
  th,td{border:1px solid var(--line);padding:8px 12px;text-align:left;vertical-align:top}
  th{background:#241f1b;color:var(--copper);font-family:"Inria Sans";font-weight:700}
  tr:nth-child(even) td{background:#1a1814}
  hr{border:0;border-top:1px solid var(--line);margin:2.4em 0}
  .mermaid{background:var(--panel);border:1px solid var(--line);padding:18px;margin:1.4em 0;text-align:center}
  .topbar{font-family:"JetBrains Mono",monospace;font-size:.74rem;color:var(--muted);letter-spacing:.08em;text-transform:uppercase;margin-bottom:8px}
  .switch{margin:0 0 26px;font-family:"JetBrains Mono",monospace;font-size:.78rem}
  .switch a{border:1px solid var(--line);padding:4px 10px;margin:0 6px 6px 0;color:var(--muted);display:inline-block}
  .switch a.active{border-color:var(--copper);color:var(--copper)}
  ::selection{background:var(--copper);color:#151311}
</style>
</head>
<body>
<div class="wrap">
  <div class="topbar">Pact Network · architecture docs · generated 2026-06-02 · updated 2026-06-03 · feat/multi-network</div>
  <div class="switch">${nav(d)}</div>
  <article id="content">Loading…</article>
</div>
<script id="md" type="text/plain">${b64}</script>
<script src="https://cdn.jsdelivr.net/npm/marked@12/marked.min.js"></script>
<script type="module">
  import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs";
  const b64 = document.getElementById("md").textContent.trim();
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const md = new TextDecoder("utf-8").decode(bytes);
  const el = document.getElementById("content");
  el.innerHTML = marked.parse(md);
  el.querySelectorAll("code.language-mermaid").forEach(c => {
    const pre = document.createElement("pre");
    pre.className = "mermaid";
    pre.textContent = c.textContent;
    (c.closest("pre") || c).replaceWith(pre);
  });
  mermaid.initialize({ startOnLoad:false, theme:"dark",
    themeVariables:{ primaryColor:"#241f1b", primaryTextColor:"#e7e1d8", primaryBorderColor:"#B87333", lineColor:"#5A6B7A", fontFamily:"JetBrains Mono, monospace" },
    securityLevel:"loose" });
  await mermaid.run({ querySelector:".mermaid" });
</script>
</body>
</html>`;
  writeFileSync(base + d.out, html, "utf8");
  console.log("wrote", d.out, `(${(html.length/1024).toFixed(1)} KB)`);
}
