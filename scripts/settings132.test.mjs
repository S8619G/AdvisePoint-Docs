// Real built application, isolated data, no production library or Windows process.
// QA inventory: exact tab order/placement at desktop and mobile; manager dialog
// and counts; storage polling; GitHub failure independence; scan; guide install;
// stop cancel/busy/accept/relaunch; no-heartbeat runtime survival.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
const root = resolve(import.meta.dirname, ".."), base = "http://127.0.0.1:5197";
let temp, server, browser, log = "";
const delay = ms => new Promise(r => setTimeout(r, ms));
const evidence = join(root, "verification/settings132");
async function start() {
  server = spawn(process.execPath, ["dist/index.cjs"], { cwd: root, env: {
    ...process.env, NODE_ENV: "production", PORT: "5197", LOCALAPPDATA: temp,
    RAG_DB_PATH: join(temp, "test.db"), RAG_PAGES_DIR: join(temp, "pages"),
    APD_LOG_DIR: join(temp, "logs"), APD_OPEN_BROWSER: "0", RAG_NO_SEED: "1",
    // Legacy environment value only shortens the diagnostic threshold now.
    RAG_IDLE_SHUTDOWN_MS: "100",
  }, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", b => log += b); server.stderr.on("data", b => log += b);
  for (let n = 0; n < 180; n++) {
    try { if ((await fetch(base + "/api/health")).ok) return; } catch {}
    await delay(100);
  }
  throw Error(log);
}
before(async () => {
  temp = mkdtempSync(join(tmpdir(), "apd-settings132-")); mkdirSync(evidence, { recursive: true });
  await start(); browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
  if (server?.exitCode === null) { server.kill(); await new Promise(r => server.once("exit", r)); }
  writeFileSync(join(evidence, "server.log"), log);
  rmSync(temp, { recursive: true, force: true });
});
test("missing browser heartbeats do not stop the built service", async () => {
  await fetch(base + "/api/heartbeat");
  await delay(11500); // Pass a real watchdog tick, with no page/heartbeat running.
  assert.equal((await fetch(base + "/api/health")).status, 200);
  assert.match(log, /keeping local service running/);
});
test("Settings placement, dialogs, storage polling and recovery layout", async () => {
  const p = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; p.on("pageerror", e => errors.push(e.message));
  await p.route("https://api.github.com/**", r => r.abort("failed"));
  try {
    await p.goto(base + "/#/schema");
    await p.getByTestId("storage-breakdown").waitFor();
    await p.getByTestId("button-check-updates").click();
    await p.getByText(/Couldn't reach GitHub/).waitFor();
    assert.equal((await fetch(base + "/api/health")).status, 200);
    const scan = p.getByTestId("panel-library-scan"), diagnostics = p.getByTestId("panel-diagnostics");
    const a = await scan.boundingBox(), b = await diagnostics.boundingBox();
    assert.ok(b.x > a.x); assert.ok(Math.abs(a.y - b.y) < 2);
    assert.equal(await p.getByTestId("card-manage-values").count(), 0);
    assert.equal(await p.getByTestId("card-welcome-guide").count(), 0);
    await p.getByTestId("button-scan-library").click();
    await p.getByTestId("text-scan-summary").waitFor();
    await p.evaluate(() => window.scrollTo(0, 0));
    await p.screenshot({ path: join(evidence, "system-desktop.png"), fullPage: true, animations: "disabled" });
    await p.getByTestId("button-stop-application").click();
    await p.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal((await fetch(base + "/api/health")).status, 200);
    await p.setViewportSize({ width: 375, height: 900 });
    const mobileA = await scan.boundingBox(), mobileB = await diagnostics.boundingBox();
    assert.ok(mobileB.y > mobileA.y + mobileA.height - 1);
    assert.ok(Math.abs(mobileA.x - mobileB.x) < 2);
    for (const card of [scan, diagnostics])
      assert.equal(await card.evaluate(e => e.scrollWidth <= e.clientWidth + 1), true);
    await p.evaluate(() => window.scrollTo(0, 0));
    await p.screenshot({ path: join(evidence, "system-mobile.png"), fullPage: true, animations: "disabled" });
    await p.setViewportSize({ width: 1440, height: 1000 });
    await p.getByTestId("tab-formats").click();
    const manager = p.getByTestId("card-manage-values");
    await manager.waitFor();
    const parentOrder = await manager.evaluate(e => [...e.parentElement.children].map(c => c.textContent.slice(0, 60)));
    assert.match(parentOrder[0], /Document types/); assert.match(parentOrder[1], /Manage Product Lists/);
    await p.getByTestId("button-open-manage-values").click();
    await p.getByRole("heading", { name: "Manage Product Lists", exact: true }).waitFor();
    await p.screenshot({ path: join(evidence, "product-lists-dialog.png"), animations: "disabled" });
    await p.keyboard.press("Escape");
    await p.evaluate(() => window.scrollTo(0, 0));
    await p.screenshot({ path: join(evidence, "formats-desktop.png"), fullPage: true, animations: "disabled" });
    await p.getByTestId("tab-backup-restore").click();
    const guide = p.getByTestId("card-welcome-guide"); await guide.waitFor();
    assert.equal(await guide.evaluate(e => e === e.parentElement.lastElementChild), true);
    await guide.scrollIntoViewIfNeeded();
    await p.screenshot({ path: join(evidence, "backup-guide-bottom.png"), animations: "disabled" });
    // Reinstall affects only the disposable test library.
    const installed = p.waitForResponse(r => r.url().endsWith("/api/system/reinstall-welcome-guide") && r.request().method() === "POST");
    await p.getByTestId("button-reinstall-welcome-guide").click();
    assert.equal((await installed).status(), 200);
    await p.getByTestId("tab-system").click();
    let polls = 0; p.on("response", r => { if (r.url().endsWith("/api/backup/size")) polls++; });
    await delay(16500); assert.ok(polls >= 1, "storage polls without reopening or restarting");
    assert.equal(await p.getByTestId("backend-down-overlay").count(), 0);
    assert.equal((await fetch(base + "/api/health")).status, 200);
    assert.deepEqual(errors, []);
  } finally { await p.close(); }
});
test("moved Product Lists preserves usage counts, rename, merge and clear without losing documents", async () => {
  const ids = [];
  const kind = (await (await fetch(base + "/api/document-types")).json()).types[0].key;
  for (const model of ["Alpha", "Beta"]) {
    const form = new FormData();
    form.append("file", new Blob([`Configuration instructions for ${model}`]), `${model}.txt`);
    form.append("metadata", JSON.stringify({ title: model, document_type: kind, product_model: model, product_family: "Family A" }));
    const response = await fetch(base + "/api/upload", { method: "POST", body: form });
    const data = await response.json(); assert.equal(response.status, 200, JSON.stringify(data));
    ids.push(data.document.id);
  }
  const p = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await p.route("https://api.github.com/**", r => r.abort("failed"));
  try {
    await p.goto(base + "/#/schema");
    await p.getByTestId("tab-formats").click();
    await p.getByTestId("button-open-manage-values").click();
    await p.getByTestId("row-value-Alpha").getByText("1 document", { exact: true }).waitFor();
    for (const [from, to] of [["Alpha", "Gamma"], ["Gamma", "Beta"]]) {
      await p.getByTestId(`button-rename-value-${from}`).click();
      await p.getByTestId("input-rename-value").fill(to);
      await p.getByTestId("button-values-apply").click();
      await p.getByTestId("button-confirm-rename").click();
      await p.getByTestId(`row-value-${to}`).waitFor();
    }
    await p.getByTestId("row-value-Beta").getByText("2 documents", { exact: true }).waitFor();
    await p.screenshot({ path: join(evidence, "product-list-merge-counts.png"), animations: "disabled" });
    await p.getByTestId("button-delete-value-Beta").click();
    await p.getByTestId("button-delete-mode-clear").click();
    await p.getByTestId("button-delete-apply").click();
    await p.getByTestId("text-no-values").waitFor();
    await p.getByTestId("button-field-product_family").click();
    await p.getByTestId("row-value-Family A").getByText("2 documents", { exact: true }).waitFor();
    for (const id of ids) {
      const { document: doc } = await (await fetch(base + `/api/documents/${id}`)).json();
      assert.equal(doc.product_model || "", "");
      assert.equal(doc.product_family, "Family A");
    }
  } finally { await p.close(); }
});
test("explicit stop blocks active update, then stops intentionally and relaunches with library retained", async () => {
  const p = await browser.newPage();
  await p.route("https://api.github.com/**", r => r.abort("failed"));
  try {
    await p.goto(base + "/#/schema");
    const dir = join(temp, "AdvisePoint Docs"); mkdirSync(dir, { recursive: true });
    const status = join(dir, "update-status.json");
    writeFileSync(status, JSON.stringify({ phase: "preparing" }));
    await p.getByTestId("button-stop-application").click();
    await p.getByTestId("button-confirm-stop").click();
    await p.getByRole("alertdialog").getByText(/Work is still active/).waitFor();
    assert.equal((await fetch(base + "/api/health")).status, 200);
    rmSync(status);
    const oldDocs = await (await fetch(base + "/api/documents")).json();
    await p.getByTestId("button-confirm-stop").click();
    await p.getByTestId("application-stopped").waitFor();
    await delay(400); assert.equal(server.exitCode, 0);
    await start();
    assert.deepEqual(await (await fetch(base + "/api/documents")).json(), oldDocs);
    await p.getByRole("button", { name: "Check again", exact: true }).click();
    await p.getByTestId("application-stopped").waitFor({ state: "hidden" });
  } finally { await p.close(); }
});
test("unchanged updater shutdown rejects browser Origin and accepts updater handshake", async () => {
  const endpoint = base + "/api/updater/shutdown";
  assert.equal((await fetch(endpoint, { method: "POST", headers: {
    Origin: base, "X-APD-Updater": "1",
  } })).status, 403);
  assert.equal((await fetch(base + "/api/health")).status, 200);
  assert.equal((await fetch(endpoint, { method: "POST", headers: { "X-APD-Updater": "1" } })).status, 200);
  await delay(500);
  assert.equal(server.exitCode, 0);
});
