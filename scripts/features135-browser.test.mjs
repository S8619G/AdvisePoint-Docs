// v1.3.5 QA: Library quick search and Query Auto Search against the real built
// server with disposable data only (port 5193, temporary data directory).
// Desktop/narrow screenshots are written to verification/features135/.
// Requires: npm run build:nobump, Playwright Chromium.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const root = resolve(import.meta.dirname, "..");
const PORT = "5193";
const base = `http://127.0.0.1:${PORT}`;
const evidence = join(root, "verification/features135");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let temp, server, browser, log = "", types;
const docs = {};

async function api(path, body) {
  const r = await fetch(base + path, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await r.json(); assert.ok(r.ok, JSON.stringify(data)); return data;
}
async function upload(key, fileName, text, meta) {
  const form = new FormData();
  form.append("file", new Blob([text]), fileName);
  form.append("metadata", JSON.stringify(meta));
  const r = await fetch(base + "/api/upload", { method: "POST", body: form });
  const d = await r.json(); assert.equal(r.status, 200, JSON.stringify(d)); docs[key] = d.document;
}
async function page(path, viewport = { width: 1440, height: 1000 }) {
  const p = await browser.newPage({ viewport });
  await p.route("https://api.github.com/**", (r) => r.abort());
  await p.goto(base + path);
  return p;
}
const cards = (p) => p.locator('[data-testid^="card-doc-"]');
const countText = (p) => p.getByTestId("text-library-count").innerText();

before(async () => {
  temp = mkdtempSync(join(tmpdir(), "apd-features135-"));
  mkdirSync(evidence, { recursive: true });
  server = spawn(process.execPath, ["dist/index.cjs"], { cwd: root, env: {
    ...process.env, NODE_ENV: "production", PORT, RAG_DB_PATH: join(temp, "test.db"),
    RAG_PAGES_DIR: join(temp, "pages"), APD_LOG_DIR: join(temp, "logs"), LOCALAPPDATA: temp,
    APPDATA: temp, RAG_NO_SEED: "1", APD_OPEN_BROWSER: "0", APD_LOCAL_TEST: "1",
  }, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", (b) => (log += b)); server.stderr.on("data", (b) => (log += b));
  for (let i = 0; i < 150; i++) { try { if ((await fetch(base + "/api/health")).ok) break; } catch {} await delay(100); }
  browser = await chromium.launch({ headless: true });
  types = (await api("/api/document-types")).types;
  const t0 = types[0].key, t1 = types[1].key;
  await upload("fax", "MZ9500ci-MZ10500iSeriesENOGR2025.09-FAX.txt", "Fax forwarding setup and calibration.",
    { title: "MZ9500ci / MZ10500i Series FAX Operation Guide", document_type: t0, product_model: "MZ9500ci", product_family: "MZ Series", tags: ["forwarding"] });
  await upload("sm", "MZ9500ci_SM_Rev4.txt", "Calibration procedure. The zebrafluid reservoir is checked monthly.",
    { title: "MZ9500ci Service Manual", document_type: t0, product_model: "MZ9500ci", product_family: "MZ Series", tags: ["fuser"] });
  await upload("hypas", "HyPASENCG.txt", "Calibration of licensing for applications.",
    { title: "HyPAS Installation Guide", document_type: t1, product_model: "HyPAS", product_family: "Software", tags: ["license"] });
  await upload("eco", "ECOSYS_PL_2024.txt", "Calibration parts and toner list.",
    { title: "ECOSYS Parts List", document_type: t0, product_model: "M3655idn", product_family: "ECOSYS", tags: ["toner"] });
});
after(async () => {
  await browser?.close();
  if (server?.exitCode === null) { server.kill(); await new Promise((r) => server.once("exit", r)); }
  writeFileSync(join(evidence, "server.log"), log);
  rmSync(temp, { recursive: true, force: true });
});

// ---------------------------------------------------------------- Library

test("Library layout: description right-aligned on the heading line, search under the heading", async () => {
  const p = await page("/#/library");
  try {
    await cards(p).first().waitFor();
    const h1 = await p.getByRole("heading", { name: "Library", exact: true }).boundingBox();
    const desc = await p.getByTestId("text-library-description").boundingBox();
    const input = await p.getByTestId("input-library-quick-search").boundingBox();
    const btn = await p.getByTestId("button-library-quick-search").boundingBox();
    const sort = await p.getByTestId("select-sort-by").boundingBox();
    const main = await p.getByTestId("form-library-quick-search").boundingBox();
    assert.ok(Math.abs((desc.y + desc.height / 2) - (h1.y + h1.height / 2)) < 12, "description on the heading line");
    assert.ok(desc.x > h1.x + h1.width + 40, "description to the right of the heading");
    assert.ok(Math.abs((desc.x + desc.width) - (main.x + main.width)) < 4, "description right-aligned");
    assert.ok(input.y > h1.y + h1.height - 2 && input.y < sort.y, "search between heading and toolbar");
    assert.ok(Math.abs(input.x - h1.x) < 4, "search starts under the heading");
    assert.ok(btn.x > input.x + input.width && Math.abs(btn.y - input.y) < 4, "Search button beside the box");
    assert.equal(await p.getByTestId("input-library-quick-search").getAttribute("placeholder"), "Search names, file names, models, tags…");
    assert.equal(await countText(p), "4 of 4 documents");
    await p.screenshot({ path: join(evidence, "library-desktop.png") });
    await p.setViewportSize({ width: 700, height: 900 });
    await delay(200);
    const d2 = await p.getByTestId("text-library-description").boundingBox();
    assert.ok(d2.x + d2.width <= 700, "no horizontal overflow when narrow");
    await p.screenshot({ path: join(evidence, "library-narrow.png") });
  } finally { await p.close(); }
});

test("Library quick search: matching, Enter/Search, typing alone, counts, folded cards", async () => {
  const p = await page("/#/library");
  try {
    await cards(p).first().waitFor();
    const box = p.getByTestId("input-library-quick-search");
    await box.fill("MZ9500 fax");
    await delay(200);
    assert.equal(await cards(p).count(), 4, "typing alone does not filter");
    await box.press("Enter");
    await p.waitForFunction(() => document.querySelectorAll('[data-testid^="card-doc-"]').length === 1);
    assert.equal(await p.getByTestId(`card-doc-${docs.fax.id}`).count(), 1);
    assert.equal(await countText(p), "1 of 4 documents");
    assert.match(await p.getByTestId("pill-library-quick-search").innerText(), /Matches for “MZ9500 fax” in names and details/);
    const h = (await p.getByTestId(`card-doc-${docs.fax.id}`).boundingBox()).height;
    assert.ok(h < 80, `matching card stays folded (${h}px)`);
    await p.screenshot({ path: join(evidence, "library-search-result.png") });

    for (const q of ["MZ9500ci FAX", "MZ9500ci-FAX", "mz9500ci_fax", "ENOGR2025.09"]) {
      await box.fill(q); await p.getByTestId("button-library-quick-search").click();
      await p.waitForFunction(() => document.querySelectorAll('[data-testid^="card-doc-"]').length === 1);
      assert.equal(await p.getByTestId(`card-doc-${docs.fax.id}`).count(), 1, q);
    }
    // Field coverage: original file name, tag, family, model, type key.
    const expect = async (q, ids) => {
      await box.fill(q); await box.press("Enter"); await delay(150);
      const got = await cards(p).evaluateAll((els) => els.map((e) => e.dataset.testid.replace("card-doc-", "")).sort());
      assert.deepEqual(got, ids.map((k) => String(docs[k].id)).sort(), q);
    };
    await expect("HyPASENCG", ["hypas"]);
    await expect("fuser", ["sm"]);
    await expect("ecosys", ["eco"]);
    await expect("mz series", ["fax", "sm"]);
    await expect(types[1].key.replace(/_/g, " "), ["hypas"]);
    await expect("MZ9500ci", ["fax", "sm"]);

    // Document text is never searched.
    await box.fill("zebrafluid"); await box.press("Enter");
    await p.getByTestId("text-no-docs").waitFor();
    assert.match(await p.getByTestId("text-no-docs").innerText(), /No documents match “zebrafluid”/);
    assert.equal(await countText(p), "0 of 4 documents");
    await p.screenshot({ path: join(evidence, "library-no-matches.png") });
    await p.getByTestId("button-no-docs-clear-search").click();
    await p.waitForFunction(() => document.querySelectorAll('[data-testid^="card-doc-"]').length === 4);
    assert.equal(await box.inputValue(), "");
    assert.equal(await box.evaluate((e) => e === document.activeElement), true, "focus returns to the box");
  } finally { await p.close(); }
});

test("Library quick search: clear controls, Reset, filters, tab switch and restart", async () => {
  const p = await page("/#/library");
  try {
    await cards(p).first().waitFor();
    const box = p.getByTestId("input-library-quick-search");
    const run = async (q) => { await box.fill(q); await box.press("Enter"); await delay(150); };

    await run("MZ9500ci");
    assert.equal(await cards(p).count(), 2);
    await box.press("Escape");
    await p.waitForFunction(() => document.querySelectorAll('[data-testid^="card-doc-"]').length === 4);
    assert.equal(await box.inputValue(), "");

    await run("MZ9500ci");
    await p.getByTestId("button-clear-library-quick-search").click();
    assert.equal(await cards(p).count(), 4);

    await run("MZ9500ci");
    await p.getByTestId("button-pill-clear-library-quick-search").click();
    assert.equal(await cards(p).count(), 4);
    assert.equal(await p.getByTestId("pill-library-quick-search").count(), 0);

    // Emptying the box by editing removes the applied search.
    await run("MZ9500ci");
    await box.fill("");
    await delay(100);
    assert.equal(await cards(p).count(), 4);

    // Combines with filters: both must match. Sort and filters survive Clear.
    await p.getByTestId("select-filter-type").click();
    await p.getByRole("option", { name: types[0].label, exact: true }).click();
    assert.equal(await cards(p).count(), 3);
    await run("operation");
    assert.equal(await cards(p).count(), 1, "type filter AND search");
    assert.equal(await p.getByTestId(`card-doc-${docs.fax.id}`).count(), 1);
    await box.press("Escape");
    assert.equal(await cards(p).count(), 3, "filters intact after clearing search");

    // Reset clears search, sort and filters.
    await run("MZ9500ci");
    assert.equal(await p.getByTestId("button-reset-filters").isDisabled(), false);
    await p.getByTestId("button-reset-filters").click();
    assert.equal(await box.inputValue(), "");
    assert.equal(await cards(p).count(), 4);
    assert.equal(await p.getByTestId("button-reset-filters").isDisabled(), true);

    // Typed but not applied text also enables Reset.
    await box.fill("draft");
    assert.equal(await p.getByTestId("button-reset-filters").isDisabled(), false);
    await box.fill("");

    // Stays while switching tabs; not written to the URL.
    await run("fuser");
    assert.equal(await cards(p).count(), 1);
    assert.ok(!(await p.evaluate(() => location.hash)).includes("fuser"));
    await p.getByRole("link", { name: "Query", exact: true }).click();
    await p.getByTestId("input-query").waitFor();
    await p.getByRole("link", { name: "Library", exact: true }).click();
    await cards(p).first().waitFor();
    assert.equal(await box.inputValue(), "fuser");
    assert.equal(await cards(p).count(), 1);

    // Clears on restart (fresh page load).
    await p.reload();
    await cards(p).first().waitFor();
    assert.equal(await p.getByTestId("input-library-quick-search").inputValue(), "");
    assert.equal(await cards(p).count(), 4);

    // Search text is rendered as text, not markup.
    await p.getByTestId("input-library-quick-search").fill("<img src=x onerror=alert(1)>");
    await p.getByTestId("input-library-quick-search").press("Enter");
    await p.getByTestId("text-no-docs").waitFor();
    assert.equal(await p.locator('[data-testid="pill-library-quick-search"] img').count(), 0);
    assert.equal(await p.locator('[data-testid="text-no-docs"] img').count(), 0);
  } finally { await p.close(); }
});

test("Library quick search: dark theme renders legibly", async () => {
  const p = await page("/#/library");
  try {
    await cards(p).first().waitFor();
    await p.evaluate(() => document.documentElement.classList.add("dark"));
    await p.getByTestId("input-library-quick-search").fill("MZ9500ci");
    await p.getByTestId("input-library-quick-search").press("Enter");
    await delay(200);
    await p.screenshot({ path: join(evidence, "library-dark.png") });
  } finally { await p.close(); }
});

// ---------------------------------------------------------------- Query

function trackSearches(p) {
  const reqs = [];
  p.on("request", (r) => { if (r.url().endsWith("/api/search") && r.method() === "POST") reqs.push(r.postDataJSON()); });
  return reqs;
}
async function selectOption(p, testid, name) {
  await p.getByTestId(testid).click();
  await p.getByRole("option", { name, exact: true }).click();
}
async function manualSearch(p, q) {
  await p.getByTestId("input-query").fill(q);
  const r = p.waitForResponse((r) => r.url().endsWith("/api/search"));
  await p.getByTestId("button-search").click(); await r;
}

test("Auto Search: on by default, re-runs after a search, never before one or from an empty box", async () => {
  const p = await page("/#/query");
  try {
    const sw = p.getByTestId("switch-auto-search");
    await sw.waitFor();
    assert.equal(await sw.getAttribute("aria-checked"), "true");
    assert.equal(await sw.getAttribute("role"), "switch");
    const reqs = trackSearches(p);

    // No search has run yet: filter changes do not search.
    await p.getByTestId("input-query").fill("calibration");
    await selectOption(p, "select-filter-model", "MZ9500ci");
    await delay(700);
    assert.equal(reqs.length, 0, "no search before the first search");

    await manualSearch(p, "calibration");
    assert.equal(reqs.length, 1);
    await p.screenshot({ path: join(evidence, "query-filters-header.png") });

    const next = p.waitForResponse((r) => r.url().endsWith("/api/search"));
    await selectOption(p, "select-filter-model", "HyPAS");
    await next; await delay(500);
    assert.equal(reqs.length, 2);
    assert.deepEqual(reqs[1].filters.product_model, ["HyPAS"]);
    assert.equal(reqs[1].query, "calibration");

    // Empty box: no re-run.
    await p.getByTestId("input-query").fill("");
    await selectOption(p, "select-filter-model", "M3655idn");
    await delay(700);
    assert.equal(reqs.length, 2, "empty box never searches");

    // Reset never searches, and afterwards changes wait for Search.
    await p.getByTestId("input-query").fill("calibration");
    await p.getByTestId("button-reset-query").click();
    await delay(500);
    assert.equal(reqs.length, 2, "Reset never searches");
    await p.getByTestId("input-query").fill("calibration");
    await selectOption(p, "select-filter-model", "MZ9500ci");
    await delay(700);
    assert.equal(reqs.length, 2, "no re-run after Reset until Search");
  } finally { await p.close(); }
});

test("Auto Search: coalesces rapid changes, slider re-runs on release, stale replies ignored", async () => {
  const p = await page("/#/query");
  try {
    const reqs = trackSearches(p);
    await manualSearch(p, "calibration");
    // Rapid tag toggles -> one search with the final state.
    await p.getByTestId("chip-filter-tag-fuser").click();
    await p.getByTestId("chip-filter-tag-toner").click();
    await p.getByTestId("chip-filter-tag-license").click();
    await delay(900);
    assert.equal(reqs.length, 2, `one re-run for rapid changes, got ${reqs.length - 1}`);
    assert.deepEqual([...reqs[1].filters.tags].sort(), ["fuser", "license", "toner"]);

    // Slider keyboard step commits -> one re-run with the new limit.
    const thumb = p.getByTestId("slider-max-results").getByRole("slider");
    await thumb.focus();
    await thumb.press("ArrowRight");
    await delay(800);
    assert.equal(reqs.length, 3);
    assert.notEqual(reqs[2].top_k, reqs[1].top_k);

    // Slider drag: many value changes, one search on release.
    const sbox = await p.getByTestId("slider-max-results").boundingBox();
    await p.mouse.move(sbox.x + sbox.width * 0.3, sbox.y + sbox.height / 2);
    await p.mouse.down();
    for (let i = 1; i <= 8; i++) { await p.mouse.move(sbox.x + sbox.width * (0.3 + i * 0.05), sbox.y + sbox.height / 2); await delay(60); }
    await delay(500);
    assert.equal(reqs.length, 3, "no search while dragging");
    await p.mouse.up();
    await delay(800);
    assert.equal(reqs.length, 4, "one search on release");

    // Stale reply: delay the first auto response; the newer one must win.
    await p.getByTestId("button-clear-filters").click();
    await delay(900);
    const baseCount = reqs.length;
    let release; const held = new Promise((r) => (release = r)); let n = 0;
    await p.route("**/api/search", async (route) => {
      n++;
      if (n === 1) { await held; }
      await route.continue();
    });
    await selectOption(p, "select-filter-model", "M3655idn"); // re-run 1 (held)
    await delay(700);
    await selectOption(p, "select-filter-model", "HyPAS"); // re-run 2 (fast)
    await delay(900);
    release();
    await delay(900);
    assert.equal(reqs.length, baseCount + 2);
    const titles = await p.locator('[data-testid^="card-result-"]').allInnerTexts();
    assert.ok(titles.length > 0);
    // Result cards show the matched excerpt: HyPAS = "licensing", M3655idn = "toner list".
    assert.ok(titles.every((t) => !t.includes("toner list")), "older response must not replace the newer one");
    assert.ok(titles.some((t) => t.includes("licensing")), "newer results shown");
    await p.unroute("**/api/search");
  } finally { await p.close(); }
});

test("Auto Search: one Recent searches entry per chain; off waits for Search and persists", async () => {
  await api("/api/query-history/clear", {}).catch(() => {});
  await fetch(base + "/api/query-history", { method: "DELETE" }).catch(() => {});
  const p = await page("/#/query");
  try {
    const reqs = trackSearches(p);
    await manualSearch(p, "procedure");
    for (const m of ["MZ9500ci", "HyPAS", "M3655idn"]) {
      const r = p.waitForResponse((r) => r.url().endsWith("/api/search"));
      await selectOption(p, "select-filter-model", m); await r; await delay(500);
    }
    await delay(500);
    const hist = (await api("/api/query-history")).history.filter((e) => e.q === "procedure");
    assert.equal(hist.length, 2, JSON.stringify(hist.map((e) => e.filters.productModel)));
    assert.equal(hist[0].filters.productModel, "M3655idn");
    assert.equal(hist[1].filters.productModel ?? "", "");
    assert.ok(!("replaces" in hist[0]), "replaces is not stored");

    // Off: filter changes wait for Search.
    await p.getByTestId("switch-auto-search").click();
    assert.equal(await p.getByTestId("switch-auto-search").getAttribute("aria-checked"), "false");
    const before = reqs.length;
    await selectOption(p, "select-filter-model", "HyPAS");
    await delay(800);
    assert.equal(reqs.length, before, "no re-run while off");
    const r = p.waitForResponse((r) => r.url().endsWith("/api/search"));
    await p.getByTestId("button-search").click(); await r;
    assert.equal(reqs.length, before + 1);

    // Remembered across restarts (fresh load).
    await p.reload();
    await p.getByTestId("switch-auto-search").waitFor();
    assert.equal(await p.getByTestId("switch-auto-search").getAttribute("aria-checked"), "false");
    await p.getByTestId("switch-auto-search").click();
    await p.reload();
    await p.getByTestId("switch-auto-search").waitFor();
    assert.equal(await p.getByTestId("switch-auto-search").getAttribute("aria-checked"), "true");

    // Keyboard toggle.
    await p.getByTestId("switch-auto-search").focus();
    await p.keyboard.press("Space");
    assert.equal(await p.getByTestId("switch-auto-search").getAttribute("aria-checked"), "false");
    await p.keyboard.press("Space");

    await p.setViewportSize({ width: 375, height: 900 });
    await p.screenshot({ path: join(evidence, "query-narrow.png"), fullPage: true });
  } finally { await p.close(); }
});
