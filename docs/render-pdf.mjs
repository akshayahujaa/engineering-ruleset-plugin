/**
 * Renders the print HTML to PDF through Chrome's DevTools Protocol.
 *
 * The CLI's --print-to-pdf gives no control over the footer: either Chrome's
 * default (which stamps a file:// URL across the bottom of every page) or
 * nothing at all. CDP's Page.printToPDF takes a footerTemplate, which is the
 * only way to get a clean running footer with page numbers.
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const [, , htmlPath, outPath, hideFrom] = process.argv;
const PORT = 9222 + Math.floor(process.uptime() * 7) % 100;

const chrome = spawn(
  CHROME,
  [
    "--headless",
    "--disable-gpu",
    "--no-sandbox",
    "--no-first-run",
    "--hide-scrollbars",
    `--remote-debugging-port=${PORT}`,
    "--user-data-dir=/tmp/chrome-pdf-profile",
    "about:blank",
  ],
  { stdio: "ignore" },
);

/** Chrome needs a moment before /json answers; poll rather than guess. */
async function endpoint() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return (await r.json()).webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error("Chrome's debugging endpoint never came up");
}

const ws = new WebSocket(await endpoint());
await new Promise((res, rej) => {
  ws.addEventListener("open", res, { once: true });
  ws.addEventListener("error", rej, { once: true });
});

let id = 0;
const pending = new Map();
const events = [];
ws.addEventListener("message", (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  } else if (msg.method) {
    events.push(msg.method);
  }
});

const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const n = (id += 1);
    pending.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

// A fresh target, so nothing about about:blank leaks into the render.
const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });

await send("Page.enable", {}, sessionId);
await send("Page.navigate", { url: `file://${htmlPath}` }, sessionId);

// Wait for load, then a beat for font resolution — a PDF taken mid-layout
// silently ships fallback faces, which is the exact defect this render fixes.
for (let i = 0; i < 80 && !events.includes("Page.loadEventFired"); i += 1) await sleep(100);
await send("Runtime.enable", {}, sessionId);

// Measurement mode: hide one part and everything after it, so the resulting
// page count says exactly where the next part begins. Everything inside .wrap
// is a sibling, so one rule does it.
if (hideFrom && hideFrom.startsWith("only:")) {
  // Show one part alone. Because every part already starts a fresh page, page 1
  // of this render is exactly the page that part gets in the full document —
  // which makes it a faithful preview, not an approximation.
  const sel = hideFrom.slice(5);
  await send(
    "Runtime.evaluate",
    {
      expression: `(() => {
        const start = document.querySelector("${sel}");
        let seen = false, ended = false;
        for (const el of [...start.parentElement.children]) {
          if (el === start) { seen = true; continue; }
          if (seen && el.tagName === "H2") ended = true;
          if (!seen || ended) el.style.display = "none";
        }
        return true;
      })()`,
    },
    sessionId,
  );
} else if (hideFrom) {
  await send(
    "Runtime.evaluate",
    {
      expression: `(() => {
        const st = document.createElement("style");
        st.textContent = "${hideFrom}, ${hideFrom} ~ * { display: none !important; }";
        document.head.appendChild(st);
        return true;
      })()`,
    },
    sessionId,
  );
}
await send(
  "Runtime.evaluate",
  { expression: "document.fonts.ready.then(() => true)", awaitPromise: true },
  sessionId,
);
await sleep(400);

const MM = 1 / 25.4; // Chrome takes inches
const footer = `
<div style="width:100%;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:7.5pt;
            color:#5a6472;padding:0 14mm;display:flex;justify-content:space-between;align-items:baseline;">
  <span style="letter-spacing:.06em;text-transform:uppercase;">The engineering ruleset workflow</span>
  <span style="font-variant-numeric:tabular-nums;">
    <span class="pageNumber"></span> / <span class="totalPages"></span>
  </span>
</div>`;

const { data } = await send(
  "Page.printToPDF",
  {
    printBackground: true,
    preferCSSPageSize: false,
    paperWidth: 210 * MM,
    paperHeight: 297 * MM,
    marginTop: 15 * MM,
    marginBottom: 17 * MM,
    marginLeft: 14 * MM,
    marginRight: 14 * MM,
    displayHeaderFooter: true,
    headerTemplate: "<span></span>",
    footerTemplate: footer,
  },
  sessionId,
);

const buf = Buffer.from(data, "base64");
// /Count on the page tree root is authoritative; the regex is a cross-check.
const counts = [...buf.toString("latin1").matchAll(/\/Count\s+(\d+)/g)].map((m) => Number(m[1]));
const pages = counts.length ? Math.max(...counts) : 0;

if (hideFrom && !hideFrom.startsWith("only:")) {
  console.log(String(pages));
} else {
  writeFileSync(outPath, buf);
  console.log(`wrote ${outPath} — ${pages} pages`);
}
ws.close();
chrome.kill();
process.exit(0);
