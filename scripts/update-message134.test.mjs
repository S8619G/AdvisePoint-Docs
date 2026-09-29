// v1.3.4 QA: provider-neutral update wording and the friendly newer-installed
// message. Real production UI; only the online release response is mocked.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const root = resolve(import.meta.dirname, "..");
const installed = readFileSync(join(root, "client/src/version.ts"), "utf8").match(/APP_VERSION = "([^"]+)"/)[1];
const bump = (delta) => {
  const p = installed.split(".").map(Number);
  p[p.length - 1] += delta;
  return p.join(".");
};
const older = (() => { const p = installed.split(".").map(Number); p[1] -= 1; return p.join("."); })();
const newer = bump(1);
const releaseUrl = (v) => `https://github.com/S8619G/advisepoint-docs/releases/tag/v${v}`;
const base = "http://127.0.0.1:5197";
let server, browser, temp;

before(async () => {
  temp = mkdtempSync(join(tmpdir(), "apd-update-msg-"));
  server = spawn(process.execPath, ["dist/index.cjs"], { cwd: root, env: {
    ...process.env, NODE_ENV: "production", PORT: "5197", LOCALAPPDATA: temp,
    RAG_DB_PATH: join(temp, "test.db"), RAG_PAGES_DIR: join(temp, "pages"),
    APD_LOG_DIR: join(temp, "logs"), APD_OPEN_BROWSER: "0", RAG_NO_IDLE_SHUTDOWN: "1",
  }, stdio: "ignore" });
  let ready = false;
  for (let i = 0; i < 180; i++) {
    try { if ((await fetch(base)).ok) { ready = true; break; } } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(ready);
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  if (server && !server.killed) {
    server.kill();
    await new Promise((r) => { server.once("exit", r); setTimeout(r, 3000); });
  }
  if (temp) rmSync(temp, { recursive: true, force: true });
});

// mode: a version string, "offline" or "invalid".
async function open(mode, { width = 1366, skipped = null } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  if (skipped) await page.addInitScript((t) => localStorage.setItem("apd:update:skip", t), skipped);
  const state = { mode, requests: 0 };
  await page.route("https://api.github.com/**", (r) => {
    state.requests++;
    if (state.mode === "offline") return r.abort("internetdisconnected");
    if (state.mode === "invalid") return r.fulfill({ json: { tag_name: "not a version", assets: [] } });
    return r.fulfill({ json: {
      tag_name: `v${state.mode}`, html_url: releaseUrl(state.mode),
      name: `AdvisePoint Docs v${state.mode}`, body: "Test only", assets: [],
      published_at: "2026-09-23T22:34:47Z",
    } });
  });
  await page.goto(base + "/#/schema");
  await page.getByTestId("button-check-updates").waitFor();
  return { page, state };
}

async function check(page) {
  await page.getByTestId("button-check-updates").click();
  await page.waitForFunction(() => {
    const b = document.querySelector('[data-testid="button-check-updates"]');
    return b && !b.disabled && !document.querySelector('[data-testid="status-checking"]');
  });
}

const cardText = (page) => page.getByTestId("card-update-check").innerText();

test("installed newer than online shows the approved neutral message with real versions", async () => {
  const { page } = await open(older);
  try {
    await check(page);
    const box = page.getByTestId("status-newer-installed");
    await box.waitFor();
    assert.equal(await page.getByTestId("text-newer-installed-title").innerText(), "You have a newer version");
    assert.equal(
      (await page.getByTestId("text-newer-installed-body").innerText()).replace(/\s+/g, " ").trim(),
      `You\u2019re running v${installed}. The latest online release is v${older}, so no updates are currently active. You will receive an alert once a newer version is available.`,
    );
    const cls = await box.getAttribute("class");
    assert.doesNotMatch(cls, /amber|destructive|red-/);
    assert.equal(await box.locator("a").count(), 0, "no release/downgrade link");
    assert.equal(await page.getByTestId("button-update-now").count(), 0, "no update or downgrade action");
    assert.equal(await page.getByTestId("banner-update-available").count(), 0, "no alert banner");
    const text = await cardText(page);
    assert.doesNotMatch(text, /github|mistyped|re-marked|tag|Reads|No account/i);
  } finally { await page.close(); }
});

test("equal version reports up to date, not the newer-installed message", async () => {
  const { page } = await open(installed);
  try {
    await check(page);
    await page.getByTestId("status-uptodate").waitFor();
    assert.equal(await page.getByTestId("status-newer-installed").count(), 0);
    assert.equal(await page.getByTestId("banner-update-available").count(), 0);
  } finally { await page.close(); }
});

test("newer online release shows the alert and neutral What's new / Download links", async () => {
  const { page } = await open(newer);
  try {
    await page.getByTestId("banner-update-available").waitFor();
    assert.equal(await page.getByTestId("link-update-notes").getAttribute("href"), releaseUrl(newer));
    assert.equal(await page.getByTestId("link-update-download").getAttribute("href"), releaseUrl(newer));
    assert.doesNotMatch(await page.getByTestId("banner-update-available").innerText(), /github/i);
    await check(page);
    await page.getByTestId("status-available").waitFor();
    assert.equal(await page.getByTestId("status-newer-installed").count(), 0);
    assert.equal(await page.getByTestId("link-panel-update-notes").getAttribute("href"), releaseUrl(newer));
    assert.equal(await page.getByTestId("link-panel-update-download").getAttribute("href"), releaseUrl(newer));
    assert.equal(await page.getByTestId("button-update-now").isEnabled(), true);
    assert.doesNotMatch(await cardText(page), /github|Reads|No account/i);
  } finally { await page.close(); }
});

test("skipped version suppresses the alert; a later release shows it again", async () => {
  const { page } = await open(newer, { skipped: `v${newer}` });
  try {
    await page.waitForTimeout(1500);
    assert.equal(await page.getByTestId("banner-update-available").count(), 0);
  } finally { await page.close(); }
  const later = await open(bump(2), { skipped: `v${newer}` });
  try {
    await later.page.getByTestId("banner-update-available").waitFor();
    await later.page.getByTestId("button-update-skip").click();
    assert.equal(await later.page.getByTestId("banner-update-available").count(), 0);
    assert.equal(await later.page.evaluate(() => localStorage.getItem("apd:update:skip")), `v${bump(2)}`);
  } finally { await later.page.close(); }
});

test("offline and invalid responses use the neutral failure state", async () => {
  for (const mode of ["offline", "invalid"]) {
    const { page } = await open(mode);
    try {
      await check(page);
      await page.getByTestId("status-offline").waitFor();
      const t = await page.getByTestId("status-offline").innerText();
      assert.match(t, /update service/);
      assert.doesNotMatch(t, /github/i);
      assert.equal(await page.getByTestId("status-newer-installed").count(), 0);
      assert.equal(await page.getByTestId("banner-update-available").count(), 0);
    } finally { await page.close(); }
  }
});

test("checking text and Check now row are provider-neutral", async () => {
  const { page, state } = await open(older);
  try {
    let release;
    const gate = new Promise((r) => { release = r; });
    await page.unroute("https://api.github.com/**");
    await page.route("https://api.github.com/**", async (r) => { await gate; state.requests++; return r.fulfill({ json: {
      tag_name: `v${older}`, html_url: releaseUrl(older), name: "x", body: "", assets: [] } }); });
    await page.getByTestId("button-check-updates").click();
    const checking = await page.getByTestId("status-checking").innerText();
    assert.match(checking, /Checking for a newer online release/);
    const row = page.getByTestId("button-check-updates").locator("xpath=..");
    assert.equal(await row.locator("a").count(), 0);
    assert.doesNotMatch(await row.innerText(), /github|Reads|No account/i);
    release();
    await page.getByTestId("status-newer-installed").waitFor();
  } finally { await page.close(); }
});

test("newer-installed message fits desktop and narrow layouts", async () => {
  for (const width of [1366, 375]) {
    const { page } = await open(older, { width });
    try {
      await check(page);
      await page.getByTestId("status-newer-installed").waitFor();
      const card = page.getByTestId("card-update-check");
      assert.equal(await card.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), true, `overflow at ${width}`);
      if (process.env.APD_QA_SCREENSHOTS) {
        await card.screenshot({ path: join(process.env.APD_QA_SCREENSHOTS, `update-newer-installed-${width}.png`) });
      }
    } finally { await page.close(); }
  }
});
