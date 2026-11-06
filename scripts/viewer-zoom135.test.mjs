// v1.3.5 regression test: retained (native) PDF pages keep their proportions
// across zoom steps. Before the fix, + after Fit or Zoom Page displayed a
// portrait page about 2.1x too tall because the page box kept a fixed height
// while maxWidth:100% narrowed it.
//
// Isolated: disposable data directory, test port 5191. Requires the built
// server (npm run build:nobump) and Playwright Chromium.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const PORT = "5191";
const base = `http://127.0.0.1:${PORT}`;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let temp, server, browser;
const docs = {};

async function json(path) {
  const r = await fetch(base + path);
  return r.json();
}

async function makePdf(w, h, label) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= 2; n++) {
    const page = pdf.addPage([w, h]);
    page.drawRectangle({ x: 20, y: 20, width: w - 40, height: h - 40, borderColor: rgb(0, 0, 0), borderWidth: 4 });
    page.drawText(`${label} page ${n}`, { x: 60, y: h - 90, size: 28, font });
  }
  return pdf.save();
}

async function upload(bytes, title, typeKey) {
  const body = new FormData();
  body.append("file", new Blob([bytes]), `${title}.pdf`);
  body.append("metadata", JSON.stringify({ title, document_type: typeKey }));
  const r = await fetch(base + "/api/upload", { method: "POST", body });
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  return j.document.id;
}

before(async () => {
  temp = mkdtempSync(join(tmpdir(), "apd-zoom135-"));
  server = spawn(process.execPath, ["dist/index.cjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT,
      RAG_DB_PATH: join(temp, "t.db"),
      RAG_PAGES_DIR: join(temp, "pages"),
      APD_LOG_DIR: join(temp, "logs"),
      APD_OPEN_BROWSER: "0",
      RAG_NO_IDLE_SHUTDOWN: "1",
      LOCALAPPDATA: temp,
    },
    stdio: "ignore",
  });
  for (let i = 0; i < 240; i++) {
    try { if ((await fetch(base + "/api/document-types")).ok) break; } catch {}
    await delay(250);
  }
  const types = (await json("/api/document-types")).types;
  docs.portrait = await upload(await makePdf(612, 792, "Portrait"), "Zoom Portrait Letter", types[0].key);
  docs.landscape = await upload(await makePdf(792, 612, "Landscape"), "Zoom Landscape Letter", types[0].key);
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  server?.kill();
  await delay(800);
  if (temp) rmSync(temp, { recursive: true, force: true });
});

async function measure(p, label) {
  await delay(1200);
  return p.evaluate((label) => {
    const vp = document.querySelector('[data-testid="viewer-viewport"]');
    const stack = document.querySelector('[data-testid="viewer-continuous-stack"]');
    let el;
    if (vp) el = vp.querySelector("canvas,img");
    else {
      el = [...(stack?.querySelectorAll("canvas,img") ?? [])].find((e) => {
        const r = e.getBoundingClientRect();
        return r.bottom > 0 && r.top < innerHeight && r.height > 0;
      });
    }
    if (!el) return { label, none: true };
    const c = el.getBoundingClientRect();
    const natural = el.tagName === "CANVAS" ? el.height / el.width : el.naturalHeight / el.naturalWidth;
    return {
      label,
      mode: vp ? "single-page" : "stack",
      tag: el.tagName,
      boxRatio: c.height / c.width,
      naturalRatio: natural,
      width: Math.round(c.width),
      height: Math.round(c.height),
    };
  }, label);
}

async function openViewer(width, title) {
  const p = await browser.newPage({ viewport: { width, height: 900 } });
  await p.goto(base + "/#/library");
  await p.getByText(title, { exact: true }).click();
  await p.getByTestId("button-view-pages").click();
  await p.getByTestId("stack-page-1").waitFor();
  return p;
}

for (const [kind, title, expected] of [
  ["portrait", "Zoom Portrait Letter", 792 / 612],
  ["landscape", "Zoom Landscape Letter", 612 / 792],
]) {
  for (const width of [1440, 1000]) {
    test(`retained ${kind} PDF keeps its shape across zoom steps at ${width}px`, async () => {
      const rows = [];
      const p = await openViewer(width, title);
      rows.push(await measure(p, "fit"));
      await p.getByTestId("button-zoom-in").click();
      rows.push(await measure(p, "plus x1"));
      await p.getByTestId("button-zoom-in").click();
      rows.push(await measure(p, "plus x2"));
      await p.getByTestId("button-zoom-out").click();
      rows.push(await measure(p, "minus"));
      await p.close();
      const q = await openViewer(width, title);
      await q.getByTestId("button-zoom-fit").click();
      rows.push(await measure(q, "zoom page"));
      await q.getByTestId("button-zoom-in").click();
      rows.push(await measure(q, "zoom page + plus"));
      await q.close();
      for (const r of rows) {
        assert.ok(!r.none, `${r.label}: no page surface found`);
        assert.equal(r.tag, "CANVAS", `${r.label}: expected the retained-PDF canvas`);
        assert.ok(Math.abs(r.boxRatio - expected) < 0.02,
          `${r.label} (${r.mode}): displayed ratio ${r.boxRatio.toFixed(3)} vs page ${expected.toFixed(3)} (${r.width}x${r.height})`);
        assert.ok(Math.abs(r.naturalRatio - expected) < 0.02,
          `${r.label}: bitmap ratio ${r.naturalRatio.toFixed(3)} vs page ${expected.toFixed(3)}`);
      }
      assert.ok(rows.some((r) => r.mode === "single-page"), "zoom-in should reach the single-page viewer");
    });
  }
}
