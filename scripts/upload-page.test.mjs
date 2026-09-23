// -----------------------------------------------------------------------------
// scripts/upload-page.test.mjs — Upload page render coverage (added v1.1.1)
// -----------------------------------------------------------------------------
//
// WHY THIS FILE EXISTS
//
// v1.1.0 shipped the Fix Title button, the Detect Document Type button, and
// per-file auto-classification. All three were unreachable in the shipped UI.
// Every v1.1.0 test passed anyway, because the suites only exercised helper
// modules in isolation (`fixTitle`, `detectDocType`, `uploadTabStore`) plus a
// Linux boot smoke test. Nothing ever mounted the Upload page and asserted
// that the controls actually render.
//
// This test closes that gap. It is deliberately a RENDER test, not a helper
// test: it drives the real production bundle in a real browser and asserts the
// controls are present in the DOM in each code path.
//
// WHY PLAYWRIGHT AND NOT happy-dom / jsdom
//
// The v1.1.1 handoff's first choice was `node --test` + happy-dom + React
// Testing Library. That would need three new dev dependencies; Playwright
// needs one and exercises the real production bundle in a real browser,
// which is a stronger guarantee for a test whose whole job is "did the
// control actually reach the shipped UI". So this uses the handoff's
// sanctioned fallback: Playwright against the built server on a temp data
// dir, keeping the prescribed filename and the `node --test` runner so it
// plugs into the existing test convention.
//
// SETUP REQUIREMENT
//
// `playwright` is a pinned devDependency (1.59.0) as of the post-v1.1.1
// tooling commit, so `npm ci` installs the library. The browser binary is
// NOT part of npm install — run this once per machine:
//
//     npm run test:upload-page:browsers      # -> playwright install chromium
//
// THIS SUITE TESTS THE BUILT BUNDLE, NOT THE SOURCE TREE.
//
// It boots `dist/` and drives it in a real browser, so a source edit is
// invisible here until you re-run `npm run build:nobump`. Learned the hard way
// during the v1.1.2 fixes: two genuinely-fixed behaviours still reported as
// failures purely because the bundle was stale. If a change you just made
// appears to have had no effect, rebuild before believing the red.
//
// This test FAILS LOUDLY rather than skipping when the browser is missing.
// That is deliberate. It is the only coverage standing between a helper-only
// test suite and a repeat of the v1.1.0 miss, where every test passed while
// three features were unreachable in the shipped UI. A skip would recreate
// exactly the false-green that caused that release.
//
// The server is booted on a private port against a throwaway APP data dir
// (RAG_DB_PATH / RAG_PAGES_DIR / APD_LOG_DIR under a mkdtemp path), with
// APD_OPEN_BROWSER=0 and idle shutdown disabled. Nothing touches the real
// user data directory.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const PORT = 5177;
const BASE = `http://127.0.0.1:${PORT}`;
// Hash routing (App.tsx uses wouter's useHashLocation), so the Upload page is
// at /#/upload — NOT /upload.
const UPLOAD_URL = `${BASE}/#/upload`;

// v1.2.5 QA inventory:
// - Four tabs/default System; all existing panels once and unchanged;
//   banner first; Welcome/values desktop pair and narrow stack.
// - Fix Title on both surfaces; original-filename parsing; repeated click;
//   edited-title compare/cancel/replace; dialog Cancel vs persisted Save;
//   legacy filename absence; no Library card-level Fix Title.
// - Picker targets the directory input only; six accepted types; nested
//   selection, summary, repeat selection/dedupe; regular input unchanged.
// - Screenshots of every Settings tab, Upload, Edit and confirmation at
//   desktop/narrow widths. Real Windows file dialogs remain field tests.

let server;
let tmpDir;
let browser;
let chromium;

/** Poll until the server answers, or throw after `timeoutMs`. */
async function waitForServer(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE, { redirect: "manual" });
      if (res.status < 500) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not come up on ${BASE} within ${timeoutMs}ms`);
}

before(async () => {
  const distEntry = path.join(repoRoot, "dist", "index.cjs");
  assert.ok(
    fs.existsSync(distEntry),
    "dist/index.cjs missing — run `npm run build:nobump` before this test",
  );

  try {
    ({ chromium } = await import("playwright"));
  } catch (err) {
    throw new Error(
      "Cannot load `playwright`, which this test requires.\n" +
      "  Fix: run `npm ci` (playwright is a pinned devDependency).\n" +
      `  Underlying error: ${err.message}`,
    );
  }

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "apd-upload-page-test-"));
  const pagesDir = path.join(tmpDir, "pages");
  const logDir = path.join(tmpDir, "logs");
  fs.mkdirSync(pagesDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });

  server = spawn(process.execPath, [distEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(PORT),
      RAG_DB_PATH: path.join(tmpDir, "test.db"),
      RAG_PAGES_DIR: pagesDir,
      APD_LOG_DIR: logDir,
      APD_OPEN_BROWSER: "0",
      RAG_NO_IDLE_SHUTDOWN: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.setEncoding("utf8");
  server.stderr.setEncoding("utf8");

  await waitForServer();

  try {
    browser = await chromium.launch();
  } catch (err) {
    // Most common cause: the library is installed but the browser binary was
    // never downloaded. Do NOT soften this into a skip -- see SETUP
    // REQUIREMENT at the top of this file.
    throw new Error(
      "Playwright could not launch Chromium, so Upload-page render coverage " +
      "did NOT run.\n" +
      "  Fix: npm run test:upload-page:browsers\n" +
      "  (equivalently: npx playwright install chromium)\n" +
      "  If `playwright install` reports your OS is unsupported, the binary " +
      "must be supplied another way -- set PLAYWRIGHT_BROWSERS_PATH to a " +
      "cached download, or run this suite on a supported platform. Do not " +
      "drop this test from the gate to get a green run.\n" +
      `  Underlying error: ${err.message}`,
    );
  }
});

after(async () => {
  if (browser) await browser.close();
  if (server && !server.killed) {
    server.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
    if (!server.killed) server.kill("SIGKILL");
  }
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Open the Upload page in a fresh browser context.
 *
 * A fresh context per test matters: uploadTabStore is a module-level store, so
 * a mode toggle set in one test would otherwise leak into the next one and
 * make these assertions order-dependent.
 */
async function openUploadPage() {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(UPLOAD_URL, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="card-upload-form"]');
  return { ctx, page };
}

/** Stage files through the real hidden <input type=file>. */
async function stageFiles(page, names) {
  await page.setInputFiles(
    '[data-testid="input-file"]',
    names.map((name) => ({
      name,
      mimeType: "application/pdf",
      // Minimal valid-enough PDF header; staging only reads name/size here.
      buffer: Buffer.from("%PDF-1.4\n% test fixture\n"),
    })),
  );
  await page.waitForSelector('[data-testid="file-list"]');
}

test("single-file staged → Fix Title and Detect type render in the metadata form", async () => {
  const { ctx, page } = await openUploadPage();
  try {
    await stageFiles(page, ["OG-widget-operator-guide.pdf"]);

    // Single-file mode: the shared MetaForm renders (no batch banner).
    await page.waitForSelector('[data-testid="input-title"]');
    assert.equal(
      await page.locator('[data-testid="batch-metadata-banner"]').count(),
      0,
      "batch banner must not render for a single staged file",
    );

    // The regression guard: before v1.1.1 the single-file MetaForm was not
    // passed originalFilename, so both of these were absent.
    assert.equal(
      await page.locator('[data-testid="button-fix-title"]').count(),
      1,
      "Fix Title button must render in single-file mode",
    );
    assert.equal(
      await page.locator('[data-testid="button-detect-doctype"]').count(),
      1,
      "Detect type button must render in single-file mode",
    );
  } finally {
    await ctx.close();
  }
});

test('two files, "Same metadata for all" → banner shown, no per-file buttons', async () => {
  const { ctx, page } = await openUploadPage();
  try {
    await stageFiles(page, ["OG-thing.pdf", "UG-other.pdf"]);

    // batch-shared is the default, so no click is needed — but assert the
    // toggle exists and that shared is the selected side.
    await page.waitForSelector('[data-testid="button-mode-shared"]');
    assert.equal(
      await page.locator('[data-testid="button-mode-perfile"]').count(),
      1,
      "per-file mode option must be offered in batch",
    );
    assert.equal(
      await page.locator('[data-testid="button-mode-shared"]').getAttribute("aria-pressed"),
      "true",
      'default batch mode must remain "Same metadata for all"',
    );

    assert.equal(
      await page.locator('[data-testid="batch-metadata-banner"]').count(),
      1,
      "batch banner must render in shared mode",
    );
    assert.equal(
      await page.locator('[data-testid="button-fix-title"]').count(),
      0,
      "no Fix Title button in shared batch mode",
    );
    assert.equal(
      await page.locator('[data-testid="button-detect-doctype"]').count(),
      0,
      "no Detect type button in shared batch mode",
    );
  } finally {
    await ctx.close();
  }
});

test('two files, "Different per file" → banner hidden, expanded card shows both buttons', async () => {
  const { ctx, page } = await openUploadPage();
  try {
    await stageFiles(page, ["OG-thing.pdf", "UG-other.pdf"]);

    await page.click('[data-testid="button-mode-perfile"]');

    assert.equal(
      await page.locator('[data-testid="batch-metadata-banner"]').count(),
      0,
      "banner must be hidden in per-file mode — the cards carry metadata",
    );

    // Collapsed cards carry no MetaForm yet.
    assert.equal(
      await page.locator('[data-testid="button-fix-title"]').count(),
      0,
      "per-file buttons only appear once a card is expanded",
    );

    // Expand the first card.
    const expanders = page.locator('[data-testid^="button-expand-"]');
    await expanders.first().click();

    await page.waitForSelector('[data-testid="button-fix-title"]');
    assert.equal(
      await page.locator('[data-testid="button-fix-title"]').count(),
      1,
      "expanded per-file card must show Fix Title",
    );
    assert.equal(
      await page.locator('[data-testid="button-detect-doctype"]').count(),
      1,
      "expanded per-file card must show Detect type",
    );
  } finally {
    await ctx.close();
  }
});

test("per-file mode auto-classifies Document type from filename codes at stage time", async () => {
  const { ctx, page } = await openUploadPage();
  try {
    // The first-boot seed (marker seeded_default_doc_types_v1) maps
    // OG → "Operator Guide" and UG → "User Guide". Wait for the mapping to be
    // readable before staging, since classification at stage time silently
    // skips while the first fetch is still in flight.
    await page.waitForFunction(
      async () => {
        const res = await fetch("/api/settings/filename-codes");
        if (!res.ok) return false;
        const body = await res.json();
        const codes = (body.mappings ?? []).map((m) => m.code);
        return codes.includes("OG") && codes.includes("UG");
      },
      undefined,
      { timeout: 30_000 },
    );

    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="card-upload-form"]');

    await stageFiles(page, ["OG-thing.pdf", "UG-other.pdf"]);
    await page.click('[data-testid="button-mode-perfile"]');

    // Expand both cards and read each card's Document type select.
    const expanders = page.locator('[data-testid^="button-expand-"]');
    const count = await expanders.count();
    assert.equal(count, 2, "expected two staged file rows");

    const labels = [];
    for (let i = 0; i < count; i += 1) {
      await expanders.nth(i).click();
      await page.waitForSelector('[data-testid$="select-document-type"]');
    }

    const selects = page.locator('[data-testid$="select-document-type"]');
    const selectCount = await selects.count();
    assert.equal(selectCount, 2, "expected one Document type select per card");
    for (let i = 0; i < selectCount; i += 1) {
      labels.push(((await selects.nth(i).innerText()) || "").trim());
    }

    // Order follows staging order: OG-thing.pdf then UG-other.pdf.
    assert.ok(
      labels.some((l) => /Operator Guide/i.test(l)),
      `expected a card showing the OG-detected type, got ${JSON.stringify(labels)}`,
    );
    assert.ok(
      labels.some((l) => /User Guide/i.test(l)),
      `expected a card showing the UG-detected type, got ${JSON.stringify(labels)}`,
    );
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------------------
// v1.1.2 field-test regressions
// ---------------------------------------------------------------------------

test("single-file upload auto-classifies Document type (TB1 field-test case)", async () => {
  const { ctx, page } = await openUploadPage();
  try {
    // Root cause this guards: v1.1.0's auto-classifier wrote only into each
    // entry's per-file meta, but the single-file layout binds MetaForm (and
    // the submit path) to `shared`. So automatic Document type detection did
    // nothing at all for single-file uploads -- for every code, not just TB.
    // Reported from the field as "the automatic document setting did not work
    // when loading a TB1 or TB file type".
    await page.waitForFunction(
      async () => {
        const res = await fetch("/api/settings/filename-codes");
        if (!res.ok) return false;
        const body = await res.json();
        return (body.mappings ?? []).some((m) => m.code === "TB");
      },
      undefined,
      { timeout: 30_000 },
    );
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="card-upload-form"]');

    await stageFiles(page, ["TB1-fuser-replacement.pdf"]);
    await page.waitForSelector('[data-testid="select-document-type"]');

    // Poll: the effect applies once the mapping query has resolved.
    await page
      .locator('[data-testid="select-document-type"]')
      .filter({ hasText: /Technical Bulletin/i })
      .first()
      .waitFor({ timeout: 15_000 });

    const label = (
      await page.locator('[data-testid="select-document-type"]').first().innerText()
    ).trim();
    assert.match(
      label,
      /Technical Bulletin/i,
      `single-file TB1 upload should auto-select Technical Bulletin, got "${label}"`,
    );
  } finally {
    await ctx.close();
  }
});

test("single-file upload does not overwrite a Document type the user chose", async () => {
  const { ctx, page } = await openUploadPage();
  try {
    // The auto-classify effect is guarded to empty/"document" only. Staging a
    // TB file AFTER an explicit choice must leave that choice intact.
    await page.waitForFunction(
      async () => {
        const res = await fetch("/api/settings/filename-codes");
        if (!res.ok) return false;
        const body = await res.json();
        return (body.mappings ?? []).some((m) => m.code === "TB");
      },
      undefined,
      { timeout: 30_000 },
    );
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="card-upload-form"]');

    // Pick a concrete non-default type before staging anything.
    await page.click('[data-testid="select-document-type"]');
    const option = page.locator('[role="option"]').filter({ hasText: /User Guide/i }).first();
    await option.waitFor({ timeout: 10_000 });
    await option.click();
    const chosen = (
      await page.locator('[data-testid="select-document-type"]').first().innerText()
    ).trim();
    assert.match(chosen, /User Guide/i, "precondition: User Guide should be selected");

    await stageFiles(page, ["TB1-fuser-replacement.pdf"]);
    await page.waitForTimeout(1500);

    const after = (
      await page.locator('[data-testid="select-document-type"]').first().innerText()
    ).trim();
    assert.match(
      after,
      /User Guide/i,
      `auto-classify must not overwrite an explicit user selection, got "${after}"`,
    );
  } finally {
    await ctx.close();
  }
});

test("Title box spans the full card width, wider than a half-width field", async () => {
  const { ctx, page } = await openUploadPage();
  try {
    // The Title Row holds a single Field inside a `sm:grid-cols-2` grid, so it
    // used to render at only half the card width -- further shortened by the
    // inline Fix Title button. v1.1.2 opts that Row out of the 2-up split.
    // Asserted geometrically against Subtitle, which is still half-width.
    await page.setViewportSize({ width: 1280, height: 900 });
    await stageFiles(page, ["TB1-fuser-replacement.pdf"]);
    await page.waitForSelector('[data-testid="input-title"]');

    const title = await page.locator('[data-testid="input-title"]').first().boundingBox();
    const subtitle = await page.locator('[data-testid="input-subtitle"]').first().boundingBox();
    assert.ok(title && subtitle, "expected both Title and Subtitle inputs to be visible");
    assert.ok(
      title.width > subtitle.width * 1.4,
      `Title input should be much wider than the half-width Subtitle field; got title=${Math.round(
        title.width,
      )}px subtitle=${Math.round(subtitle.width)}px`,
    );
  } finally {
    await ctx.close();
  }
});

test("v1.2.5 Settings has four ordered tabs and keeps Welcome/values paired", async () => {
  const { ctx, page } = await openUploadPage();
  try {
    let bannerReads = 0;
    // These panels intentionally disappear on an empty/healthy library.
    // Supply representative read-only data so placement is actually covered.
    await page.route("**/api/documents/duplicates", (route) => route.fulfill({ json: {
      ok: true, total_duplicates: 1, groups: [{
        group_key: "qa", file_name: "QA.txt", size_bytes: 100, size_source: "bytes",
        keep: "qa-keep", delete: ["qa-copy"], safe_to_delete: true, blocked_reason: null,
        docs: ["qa-keep", "qa-copy"].map((id) => ({
          id, title: id, ingested_at: "2026-09-17T14:00:00Z",
          has_pages: false, has_original: true, chunks: 1, viewable: true,
        })),
      }],
    } }));
    await page.route("**/api/render/status", (route) => route.fulfill({ json: {
      active: false, current_document: null, queue_depth: 0,
      recent_failures: [{ document_id: "qa-render", title: "QA interrupted document",
        file_name: "QA.pdf", error: "interrupted: test fixture", failed_at: "2026-09-17T14:00:00Z",
        first_failed_page: 2 }],
    } }));
    await page.route("**/api/backup/restore-banner", async (route) => {
      bannerReads++;
      await route.fulfill({ json: { record: {
        at: "2026-09-17T14:00:00Z", mode: "merge", source: "QA backup",
        documents: 3, chunks: 6, bak_dir: null, v: 1,
      } } });
    });
    await page.goto(`${BASE}/#/schema`, { waitUntil: "networkidle" });
    assert.deepEqual(await page.locator('[data-testid="tabs-schema"] [role="tab"]').allTextContents(),
      ["System", "Formats", "Backup / Restore", "Developer"]);
    assert.equal(await page.getByTestId("tab-system").getAttribute("data-state"), "active");
    assert.ok(bannerReads > 0, "banner still fetches on System mount");
    await page.getByTestId("button-restore-banner-dismiss").waitFor();
    assert.match(await page.locator('[role="tabpanel"][data-state="active"] > :first-child').innerText(),
      /Restore completed/);
    const active = page.locator('[role="tabpanel"][data-state="active"]');
    assert.equal(await active.getByTestId("card-update-check").count(), 1);
    assert.equal(await active.getByTestId("card-viewer-prefs").count(), 1);
    assert.equal(await active.getByTestId("panel-library-scan").count(), 1);
    assert.equal(await active.getByTestId("panel-diagnostics").count(), 1);
    const pair = page.getByTestId("card-manage-values").locator("..");
    assert.equal(await pair.locator(":scope > *").count(), 2);
    assert.match(await pair.locator(":scope > :first-child").innerText(), /Welcome Guide/i);
    for (const width of [1366, 700, 375]) {
      await page.setViewportSize({ width, height: 900 });
      const cols = await pair.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
      assert.equal(cols, width >= 768 ? 2 : 1);
      if (process.env.APD_QA_SCREENSHOTS) {
        await page.screenshot({ path: path.join(process.env.APD_QA_SCREENSHOTS, `system-${width}.png`), fullPage: true });
      }
    }
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.getByTestId("tab-formats").click();
    assert.match(await active.innerText(), /Document types/);
    assert.match(await active.innerText(), /Filename codes/);
    assert.equal(await active.getByTestId("card-filename-phrases").count(), 1);
    assert.equal(await active.locator("hr").count(), 2);
    assert.equal(await active.getByTestId("card-manage-values").count(), 0);
    if (process.env.APD_QA_SCREENSHOTS)
      await page.screenshot({ path: path.join(process.env.APD_QA_SCREENSHOTS, "formats.png"), fullPage: true });
    await page.getByTestId("tab-backup-restore").click();
    await active.getByTestId("backup-columns").waitFor();
    await active.getByTestId("backup-duplicates").waitFor();
    assert.equal(await active.getByTestId("backup-columns").count(), 1);
    assert.equal(await active.getByTestId("backup-duplicates").count(), 1);
    await active.getByTestId("card-render-failures").waitFor();
    assert.deepEqual(await active.locator(":scope > *").evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-testid") || el.querySelector("[data-testid]")?.getAttribute("data-testid"))
    ), ["backup-columns", "card-recovery", "backup-duplicates", "card-render-failures"]);
    assert.match(await active.innerText(), /Recovery/);
    assert.equal(await active.getByTestId("panel-library-scan").count(), 0);
    if (process.env.APD_QA_SCREENSHOTS)
      await page.screenshot({ path: path.join(process.env.APD_QA_SCREENSHOTS, "backup-restore.png"), fullPage: true });
    await page.getByTestId("tab-developer").click();
    assert.deepEqual(await active.locator("h2").allTextContents(), ["Fields", "Filter mapping", "Examples"]);
    assert.equal(await active.locator('[role="tablist"]').count(), 0);
    assert.match(await active.innerText(), /Parent document \(minimal\)/);
    if (process.env.APD_QA_SCREENSHOTS)
      await page.screenshot({ path: path.join(process.env.APD_QA_SCREENSHOTS, "developer.png"), fullPage: true });
    await page.getByTestId("tab-system").click();
    assert.equal(await page.getByTestId("card-manage-values").count(), 1);
  } finally { await ctx.close(); }
});

test("v1.2.5 Select folder targets only the directory input, stages nested files and dedupes repeats", async () => {
  const { ctx, page } = await openUploadPage();
  const fixture = path.join(tmpDir, "folder-picker-fixture");
  fs.mkdirSync(path.join(fixture, "nested"), { recursive: true });
  for (const ext of ["pdf", "docx", "rtf", "txt", "md", "markdown"]) {
    fs.writeFileSync(path.join(fixture, "nested", `guide.${ext}`), "Directory picker fixture content.");
  }
  for (const name of ["Thumbs.db", "desktop.ini", ".hidden.pdf", "unsupported.exe"]) {
    fs.writeFileSync(path.join(fixture, name), "ignored fixture");
  }
  try {
    const chooserPromise = page.waitForEvent("filechooser");
    await page.getByTestId("button-select-folder").click();
    const chooser = await chooserPromise;
    assert.equal(await chooser.element().getAttribute("data-testid"), "input-folder");
    assert.equal(await chooser.element().getAttribute("webkitdirectory"), "");
    await chooser.setFiles(fixture);
    await page.waitForFunction(() => document.querySelectorAll('[data-testid^="file-row-"]').length === 6);
    assert.equal(await page.getByTestId("input-folder").inputValue(), "");
    assert.match(await page.locator("body").innerText(), /Added 6 files from folder-picker-fixture/);
    await page.getByTestId("input-folder").setInputFiles(fixture);
    assert.equal(await page.locator('[data-testid^="file-row-"]').count(), 6);
    if (process.env.APD_QA_SCREENSHOTS)
      await page.screenshot({ path: path.join(process.env.APD_QA_SCREENSHOTS, "folder-upload.png"), fullPage: true });
  } finally { await ctx.close(); }
});

test("v1.2.5 Library Fix Title confirms custom text, cancels safely, persists Save and stays idempotent", async () => {
  const { ctx, page } = await openUploadPage();
  try {
    const response = await page.request.post(`${BASE}/api/upload`, { multipart: {
      file: { name: "TASKalfa_5054ci_OG_EN.txt", mimeType: "text/plain",
        buffer: Buffer.from("Library title QA document. This fixture tests editable title persistence without changing real user data.") },
      metadata: JSON.stringify({ title: "Hand edited QA title", product_model: "QA 5054ci", document_type: "document" }),
    } });
    assert.ok(response.ok(), await response.text());
    const { document: doc } = await response.json();
    assert.ok(doc?.id);
    await page.goto(`${BASE}/#/library`, { waitUntil: "networkidle" });
    const card = page.getByTestId(`card-doc-${doc.id}`);
    assert.equal(await card.getByTestId("button-fix-title").count(), 0);
    await card.getByRole("button", { name: "Edit document", exact: true }).click();
    await page.getByTestId("button-fix-title").click();
    const confirm = page.getByTestId("alert-fix-title-overwrite");
    await confirm.waitFor();
    assert.match(await confirm.innerText(), /Hand edited QA title/);
    assert.match(await confirm.innerText(), /Proposed title/i);
    await page.waitForTimeout(250); // let the existing dialog entrance animation finish
    if (process.env.APD_QA_SCREENSHOTS)
      await page.screenshot({ path: path.join(process.env.APD_QA_SCREENSHOTS, "title-confirmation.png") });
    await page.getByTestId("button-fix-title-cancel").click();
    assert.equal(await page.getByTestId("input-edit-title").inputValue(), "Hand edited QA title");
    await page.getByTestId("button-fix-title").click();
    await page.getByTestId("button-fix-title-replace").click();
    const suggestion = await page.getByTestId("input-edit-title").inputValue();
    assert.notEqual(suggestion, "Hand edited QA title");
    await page.getByTestId("button-fix-title").click();
    assert.equal(await page.getByTestId("input-edit-title").inputValue(), suggestion);
    assert.equal(await confirm.count(), 0);
    for (const width of [1366, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await page.getByRole("dialog").evaluate((el) => { el.scrollTop = 0; });
      await page.waitForTimeout(250);
      if (process.env.APD_QA_SCREENSHOTS)
        await page.screenshot({ path: path.join(process.env.APD_QA_SCREENSHOTS, `edit-title-${width}.png`) });
    }
    await page.getByTestId("button-edit-cancel").click();
    await card.getByRole("button", { name: "Edit document", exact: true }).click();
    assert.equal(await page.getByTestId("input-edit-title").inputValue(), "Hand edited QA title");
    await page.getByTestId("button-fix-title").click();
    await page.getByTestId("button-fix-title-replace").click();
    const saved = page.waitForResponse((r) => r.url().endsWith(`/api/documents/${doc.id}`) && r.request().method() === "PATCH");
    await page.getByTestId("button-edit-save").click();
    assert.ok((await saved).ok());
    await page.reload({ waitUntil: "networkidle" });
    await card.getByRole("button", { name: "Edit document", exact: true }).click();
    assert.equal(await page.getByTestId("input-edit-title").inputValue(), suggestion);
    assert.equal(await page.getByTestId("button-fix-title").count(), 1);
  } finally { await ctx.close(); }
});

test("v1.2.5 legacy Library documents without file_name hide Fix Title", async () => {
  const { ctx, page } = await openUploadPage();
  try {
    const docs = await (await page.request.get(`${BASE}/api/documents`)).json();
    assert.ok(docs.length > 0);
    for (const missing of [null, undefined]) {
      await page.route("**/api/documents", (route) => route.fulfill({
        json: [{ ...docs[0], file_name: missing }],
      }));
      await page.goto(`${BASE}/#/library`, { waitUntil: "networkidle" });
      await page.reload({ waitUntil: "networkidle" });
      await page.getByRole("button", { name: "Edit document", exact: true }).click();
      assert.equal(await page.getByTestId("button-fix-title").count(), 0);
      await page.getByTestId("button-edit-cancel").click();
      await page.unroute("**/api/documents");
    }
  } finally { await ctx.close(); }
});

test("v1.2.6 joined-and title fix reaches Upload and Library", async () => {
  const { ctx, page } = await openUploadPage();
  try {
    await stageFiles(page, ["CloudPrintandScan.pdf"]);
    await page.getByTestId("button-fix-title").click();
    assert.equal(await page.getByTestId("input-title").inputValue(), "Cloud Print and Scan");
    const response = await page.request.post(`${BASE}/api/upload`, { multipart: {
      file: { name: "CloudPrintandScan.txt", mimeType: "text/plain",
        buffer: Buffer.from("Cloud print and scan security regression document with searchable text.") },
      metadata: JSON.stringify({ title: "Custom cloud title", document_type: "document" }),
    } });
    assert.ok(response.ok(), await response.text());
    const { document: doc } = await response.json();
    await page.goto(`${BASE}/#/library`, { waitUntil: "networkidle" });
    await page.getByTestId(`card-doc-${doc.id}`).getByRole("button", { name: "Edit document", exact: true }).click();
    await page.getByTestId("button-fix-title").click();
    await page.getByTestId("button-fix-title-replace").click();
    assert.equal(await page.getByTestId("input-edit-title").inputValue(), "Cloud Print and Scan");
    await page.getByTestId("button-fix-title").click();
    assert.equal(await page.getByTestId("input-edit-title").inputValue(), "Cloud Print and Scan");
    const saved = page.waitForResponse((r) => r.url().endsWith(`/api/documents/${doc.id}`) && r.request().method() === "PATCH");
    await page.getByTestId("button-edit-save").click();
    assert.ok((await saved).ok());
    const docs = await (await page.request.get(`${BASE}/api/documents`)).json();
    assert.equal(docs.find((d) => d.id === doc.id).title, "Cloud Print and Scan");
  } finally { await ctx.close(); }
});

test("v1.2.6 built upload, update and restore routes survive malformed multipart fields", async () => {
  for (const endpoint of ["/api/upload", "/api/update/upload-zip", "/api/backup/import"]) {
    const body = new FormData();
    body.append("a[4294967294]", "x");
    body.append("a[]", "y");
    const response = await fetch(`${BASE}${endpoint}`, { method: "POST", body,
      signal: AbortSignal.timeout(10000) });
    assert.ok(response.status >= 400, `${endpoint}: malformed request must be refused`);
    const health = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(5000) });
    assert.equal(health.status, 200, `${endpoint}: server must remain alive`);
  }
});

test("v1.2.6 built backup export and merge import retain documents through disk uploads", async () => {
  const beforeDocs = await (await fetch(`${BASE}/api/documents`)).json();
  assert.ok(beforeDocs.length > 0);
  const exported = await fetch(`${BASE}/api/backup/export`);
  assert.equal(exported.status, 200);
  const bytes = await exported.arrayBuffer();
  assert.ok(bytes.byteLength > 0);
  const body = new FormData();
  body.append("file", new Blob([bytes], { type: "application/zip" }), "regression-backup.zip");
  body.append("mode", "merge");
  const imported = await fetch(`${BASE}/api/backup/import`, { method: "POST", body });
  assert.equal(imported.status, 200, await imported.clone().text());
  const result = await imported.json();
  assert.equal(result.ok, true);
  assert.equal(result.restart_required, false);
  const afterDocs = await (await fetch(`${BASE}/api/documents`)).json();
  assert.deepEqual(afterDocs.map((d) => d.id).sort(), beforeDocs.map((d) => d.id).sort());
});
