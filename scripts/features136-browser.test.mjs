// v1.3.6 browser test: Settings > Formats > Manage Values with Tags, on the
// BUILT app with disposable data only (port 5198, temporary data folder).
// The in-page requests carry a same-origin Origin header, so this also proves
// the cross-site guard leaves normal app flows working.
//
// Build first: npm run build:nobump
// Run: node --test --test-concurrency=1 scripts/features136-browser.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const root = resolve(import.meta.dirname, "..");
const PORT = "5198";
const base = `http://127.0.0.1:${PORT}`;
const evidence = join(root, "verification/features136");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let temp, server, browser, log = "", types;
const ids = {};

async function api(path, body) {
  const r = await fetch(base + path, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await r.json(); assert.ok(r.ok, JSON.stringify(data)); return data;
}
async function ingest(key, title, tags) {
  const d = await api("/api/ingest", { title, document_type: types[0].key, product_model: "X100", product_family: "Nova", tags, body: `${title} body.` });
  ids[key] = d.document?.id ?? d.id;
}
const tagsOf = async () => Object.fromEntries((await api("/api/documents")).map((d) => [d.id, d.tags]));

before(async () => {
  temp = mkdtempSync(join(tmpdir(), "apd-features136-ui-"));
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
  await ingest("a", "Model X100 Service Manual", ["Fuser", "Toner"]);
  await ingest("b", "Model X100 Operation Guide", ["fuser", "Fuser", "Paper"]);
  await ingest("c", "Model X200 Quick Guide", ["Toner"]);
});
after(async () => {
  await browser?.close();
  server?.kill();
  if (temp) rmSync(temp, { recursive: true, force: true });
});

async function openDialog(viewport = { width: 1440, height: 1000 }) {
  const p = await browser.newPage({ viewport });
  await p.route("https://api.github.com/**", (r) => r.abort());
  await p.goto(base + "/#/schema");
  await p.getByTestId("tab-formats").click();
  const card = p.getByTestId("card-manage-values");
  await card.waitFor();
  return { p, card };
}

test("Manage Values card and dialog are renamed and offer Tags", async () => {
  const { p, card } = await openDialog();
  try {
    await card.getByText("Manage Values", { exact: true }).first().waitFor();
    assert.match(await card.innerText(), /product models, product families and tags/);
    await card.screenshot({ path: join(evidence, "manage-values-card.png") });
    await p.getByTestId("button-open-manage-values").click();
    await p.getByRole("heading", { name: "Manage Values", exact: true }).waitFor();
    for (const f of ["product_model", "product_family", "tags"]) await p.getByTestId(`button-field-${f}`).waitFor();
    await p.getByTestId("button-field-tags").click();
    const rows = p.locator('[data-testid^="row-value-"]');
    await rows.first().waitFor();
    const texts = await rows.allInnerTexts();
    // Most used first; case variants listed separately.
    assert.match(texts[0], /^Fuser\s+2 documents/);
    assert.match(texts[1], /^Toner\s+2 documents/);
    assert.ok(texts.some((t) => /^fuser\s+1 document\b/.test(t)));
    await p.screenshot({ path: join(evidence, "manage-values-tags.png"), animations: "disabled" });
    // Product model list is unchanged.
    await p.getByTestId("button-field-product_model").click();
    await p.getByTestId("row-value-X100").waitFor();
  } finally { await p.close(); }
});

test("Tags: cancelling a rename or delete changes nothing", async () => {
  const before = await tagsOf();
  const { p } = await openDialog();
  try {
    await p.getByTestId("button-open-manage-values").click();
    await p.getByTestId("button-field-tags").click();
    await p.getByTestId("button-rename-value-Toner").click();
    await p.getByTestId("input-rename-value").fill("Toner cartridge");
    await p.getByTestId("button-values-apply").click();
    await p.getByTestId("button-confirm-cancel").click();
    await p.getByTestId("button-delete-value-Paper").click();
    await p.getByTestId("text-delete-tag").waitFor();
    await p.getByTestId("button-delete-cancel").click();
    assert.deepEqual(await tagsOf(), before);
  } finally { await p.close(); }
});

test("Tags: merge a case variant, rename and delete through the dialog", async () => {
  const { p } = await openDialog();
  try {
    await p.getByTestId("button-open-manage-values").click();
    await p.getByTestId("button-field-tags").click();
    // Merge: typing a different case of an existing tag lands on its spelling.
    await p.getByTestId("button-rename-value-fuser").click();
    await p.getByTestId("input-rename-value").fill("FUSER");
    await p.getByText(/already exists on 2 documents\. This will merge both into one tag/).waitFor();
    await p.getByTestId("button-values-apply").click();
    await p.getByRole("heading", { name: "Merge these tags?" }).waitFor();
    await p.screenshot({ path: join(evidence, "manage-values-merge-confirm.png"), animations: "disabled" });
    await p.getByTestId("button-confirm-rename").click();
    await p.getByTestId("row-value-fuser").waitFor({ state: "detached" });
    let tags = await tagsOf();
    assert.deepEqual(tags[ids.b], ["Fuser", "Paper"]);
    assert.deepEqual(tags[ids.a], ["Fuser", "Toner"]);

    // Rename
    await p.getByTestId("button-rename-value-Toner").click();
    await p.getByTestId("input-rename-value").fill("Toner cartridge");
    await p.getByTestId("button-values-apply").click();
    await p.getByRole("heading", { name: "Rename this tag?" }).waitFor();
    await p.getByTestId("button-confirm-rename").click();
    await p.getByTestId("row-value-Toner cartridge").waitFor();

    // Blank rename is not allowed for tags
    await p.getByTestId("button-rename-value-Paper").click();
    await p.getByTestId("input-rename-value").fill("");
    assert.equal(await p.getByTestId("button-values-apply").isDisabled(), true);
    await p.getByText("To remove the tag from every document, use Delete instead.", { exact: false }).waitFor();

    // Delete
    await p.getByTestId("button-delete-value-Paper").click();
    await p.getByTestId("text-delete-tag").waitFor();
    await p.screenshot({ path: join(evidence, "manage-values-delete-tag.png"), animations: "disabled" });
    await p.getByTestId("button-delete-apply").click();
    await p.getByTestId("row-value-Paper").waitFor({ state: "detached" });

    tags = await tagsOf();
    assert.deepEqual(tags[ids.a], ["Fuser", "Toner cartridge"]);
    assert.deepEqual(tags[ids.b], ["Fuser"]);
    assert.deepEqual(tags[ids.c], ["Toner cartridge"]);
    const facets = (await api("/api/facets")).tags;
    assert.deepEqual([...facets].sort(), ["Fuser", "Toner cartridge"]);
  } finally { await p.close(); }
  assert.ok(!/\[guard\] refused/.test(log), "no app request was refused by the cross-site guard");
});

test("Manage Values dialog fits a narrow window", async () => {
  const { p } = await openDialog({ width: 375, height: 800 });
  try {
    await p.getByTestId("button-open-manage-values").click();
    await p.getByTestId("button-field-tags").click();
    await p.locator('[data-testid^="row-value-"]').first().waitFor();
    // The Settings page behind the dialog already overflows at 375 px in v1.3.5
    // (measured: 294 px, unchanged in v1.3.6), so this checks the new dialog itself.
    const box = await p.evaluate(() => { const d = document.querySelector('[role="dialog"]'); const r = d.getBoundingClientRect();
      return { left: r.left, right: r.right, inner: d.scrollWidth - d.clientWidth, vw: window.innerWidth }; });
    assert.ok(box.left >= 0 && box.right <= box.vw + 1, `dialog outside window ${JSON.stringify(box)}`);
    assert.ok(box.inner <= 1, `dialog content overflows ${box.inner}px`);
    await p.screenshot({ path: join(evidence, "manage-values-tags-mobile.png"), animations: "disabled" });
  } finally { await p.close(); }
});
