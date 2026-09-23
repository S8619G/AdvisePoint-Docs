// QA: real production UI, with only Windows updater/GitHub responses mocked.
// Covers long preflight, visible failures/retry, local-ZIP flow, restart/reconnect,
// manual-download destination, and responsive layout. Native launcher is a
// separate Windows field gate, never asserted by these browser fixtures.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
const root = resolve(import.meta.dirname, "..");
const base = "http://127.0.0.1:5198";
let server, browser, temp;
before(async () => {
  temp = mkdtempSync(join(tmpdir(), "apd-update-ui-"));
  server = spawn(process.execPath, ["dist/index.cjs"], { cwd: root, env: {
    ...process.env, NODE_ENV: "production", PORT: "5198", LOCALAPPDATA: temp,
    RAG_DB_PATH: join(temp, "test.db"), RAG_PAGES_DIR: join(temp, "pages"),
    APD_LOG_DIR: join(temp, "logs"), APD_OPEN_BROWSER: "0", RAG_NO_IDLE_SHUTDOWN: "1",
  }, stdio: "ignore" });
  let ready = false;
  for (let i = 0; i < 180; i++) {
    try { if ((await fetch(base)).ok) { ready = true; break; } } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  assert.ok(ready);
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
  if (server && !server.killed) {
    server.kill();
    await new Promise(r => { server.once("exit", r); setTimeout(r, 3000); });
  }
  if (temp) rmSync(temp, { recursive: true, force: true });
});
async function open() {
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  const state = { phase: "preparing", message: "Downloading and validating the package.", startedAt: Date.now(), offline: false };
  await page.route("https://api.github.com/**", r => r.fulfill({ json: {
    tag_name: "v1.3.3", html_url: "https://github.com/S8619G/advisepoint-docs/releases/tag/v1.3.3",
    name: "Future test release", body: "Test only", assets: [],
  } }));
  await page.route("**/api/render/busy", r => r.fulfill({ json: { busy: false } }));
  await page.route("**/api/updater/launch", r => { state.startedAt = Date.now(); return r.fulfill({ json: { ok: true } }); });
  await page.route("**/api/updater/launch-local", r => { state.startedAt = Date.now(); return r.fulfill({ json: { ok: true } }); });
  await page.route("**/api/updater/status", r => state.offline ? r.abort("connectionrefused") : r.fulfill({ json: state }));
  await page.goto(base + "/#/schema");
  await page.getByTestId("button-update-now").waitFor();
  return { page, state };
}
test("slow validation keeps live UI busy without a false launch failure", async () => {
  const { page, state } = await open();
  try {
    await page.getByTestId("button-update-now").click();
    // Use real time: virtual-clock advancement does not await network polling.
    await page.waitForTimeout(26000);
    assert.equal(await page.getByTestId("text-updater-launch-failed").count(), 0);
    assert.equal(await page.getByTestId("button-update-now").isDisabled(), true);
    assert.match(await page.getByTestId("text-updater-countdown").innerText(), /server stays available/);
    state.phase = "failed"; state.message = "No compatible arm64 binary package was found. No application files were replaced.";
    await page.getByTestId("text-updater-launch-failed").waitFor();
    assert.match(await page.getByTestId("text-updater-launch-failed").innerText(), /No compatible arm64/);
    assert.equal(await page.getByTestId("button-update-now").isEnabled(), true);
    if (process.env.APD_QA_SCREENSHOTS) {
      await page.getByTestId("card-update-check").screenshot({ path: join(process.env.APD_QA_SCREENSHOTS, "update-error-desktop.png") });
      await page.setViewportSize({ width: 375, height: 900 });
      assert.equal(await page.getByTestId("card-update-check").evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
      await page.getByTestId("card-update-check").screenshot({ path: join(process.env.APD_QA_SCREENSHOTS, "update-error-mobile.png") });
    }
  } finally { await page.close(); }
});
test("manual downloads always open the release page, not an arbitrary ZIP", async () => {
  const { page } = await open();
  try {
    assert.match(await page.getByTestId("link-panel-update-download").getAttribute("href"), /\/releases\/tag\/v1\.3\.3$/);
  } finally { await page.close(); }
});
test("local-ZIP validation and failure are visible without a fake disconnect countdown", async () => {
  const { page, state } = await open();
  try {
    await page.route("**/api/update/upload-zip", r => r.fulfill({ json: {
      version: "1.2.9", installed_version: "1.2.8", temp_path: "/test/staged.zip", size: 4,
    } }));
    await page.getByTestId("input-local-zip").setInputFiles({ name: "AdvisePoint-Docs-v1.2.9-arm64.zip", mimeType: "application/zip", buffer: Buffer.from("test") });
    await page.getByTestId("button-confirm-local-zip").click();
    await page.getByTestId("local-zip-launched").waitFor();
    assert.doesNotMatch(await page.getByTestId("local-zip-launched").innerText(), /Closing in/);
    state.phase = "failed"; state.message = "Package architecture does not match. No application files were replaced.";
    await page.getByTestId("local-zip-error").waitFor();
    assert.match(await page.getByTestId("local-zip-error").innerText(), /architecture does not match/);
  } finally { await page.close(); }
});
test("temporary restart disconnection does not produce a launch error, and completion clears busy state", async () => {
  const { page, state } = await open();
  try {
    await page.getByTestId("button-update-now").click();
    state.offline = true;
    await page.waitForTimeout(2300);
    assert.equal(await page.getByTestId("text-updater-launch-failed").count(), 0);
    state.offline = false; state.phase = "complete"; state.message = "Update check completed.";
    await page.waitForTimeout(2300);
    assert.equal(await page.getByTestId("button-update-now").count(), 0);
  } finally { await page.close(); }
});
test("status endpoint handles absent, valid and damaged status files", async () => {
  const dir = join(temp, "AdvisePoint Docs");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "update-status.json");
  rmSync(file, { force: true });
  assert.equal((await (await fetch(base + "/api/updater/status")).json()).phase, "idle");
  writeFileSync(file, JSON.stringify({ phase: "failed", message: "Test failure", startedAt: 123, updatedAt: 456, privateField: "not exposed" }));
  const data = await (await fetch(base + "/api/updater/status")).json();
  assert.equal(data.message, "Test failure"); assert.equal(data.privateField, undefined);
  writeFileSync(file, "corrupt");
  assert.equal((await (await fetch(base + "/api/updater/status")).json()).phase, "idle");
});
