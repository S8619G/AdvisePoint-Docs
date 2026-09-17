// v1.0.15: Welcome Guide seeding on first launch.
//
// A fresh install has an empty library, which makes the app look broken to
// a user who just wants to open something and read it. To fix that we bundle
// a rendered "AdvisePoint Docs -- Welcome Guide" PDF into the shipped zip
// under `<APP>/welcome-guide/AdvisePoint-Docs-Welcome-Guide.pdf`, and on the
// first server boot we ingest it as a document with the FIXED id
// `seed-readme-v1`.
//
// The fixed id lets the search endpoint filter this doc out of query results
// (so it doesn't crowd real technical hits) without a schema change or a new
// DB column, and it lets the "Reinstall welcome guide" button in Settings >
// About wipe + re-ingest the same slot cleanly.
//
// Idempotence and safety:
//   * We record `seeded_welcome_guide_v1` in app_settings the first time
//     seeding runs (success OR miss). Subsequent boots see the marker and
//     do nothing. This is the "first-boot only" contract -- users can freely
//     delete the guide later without it reappearing.
//   * If the shipped PDF file cannot be located, we log a clear warning and
//     still set the marker, so a broken bundle doesn't wedge us into re-
//     trying and re-logging the same failure every boot.
//   * All errors are caught. Seeding must NEVER prevent server startup.
//
// See scripts/package-windows.mjs for the packaging side, and
// server/routes.ts for the query/facets exclusion and the reinstall
// endpoint.

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type Database from "better-sqlite3";

export const SEED_WELCOME_GUIDE_DOC_ID = "seed-readme-v1";
export const SEED_WELCOME_GUIDE_MARKER_KEY = "seeded_welcome_guide_v1";

const LOG_PREFIX = "[seed-welcome-guide]";

/** Return true if the marker is already set (any value). */
export function isWelcomeGuideSeeded(rawDb: Database.Database): boolean {
  try {
    const row = rawDb
      .prepare("SELECT value FROM app_settings WHERE key = ?")
      .get(SEED_WELCOME_GUIDE_MARKER_KEY) as { value: string } | undefined;
    return !!row;
  } catch {
    return false;
  }
}

/** Raw marker value, or null when the marker has never been written. */
export function getWelcomeGuideMarker(rawDb: Database.Database): string | null {
  try {
    const row = rawDb
      .prepare("SELECT value FROM app_settings WHERE key = ?")
      .get(SEED_WELCOME_GUIDE_MARKER_KEY) as { value: string } | undefined;
    return row ? String(row.value ?? "") : null;
  } catch {
    return null;
  }
}

// v1.1.0: self-heal eligibility.
//
// Two different situations both look like "marker set, doc missing", and they
// demand OPPOSITE behavior:
//
//   (a) The seed never actually succeeded. On the v1.0.14 -> v1.0.15 upgrade the
//       updater dropped welcome-guide/ (see packaging/updater/updater.cjs), the
//       first-boot seeder could not find the PDF, and it still wrote the marker
//       to avoid a boot-loop. Those installs are stuck: the guide never appears
//       and "Reinstall welcome guide" also fails. They SHOULD self-heal once the
//       PDF is on disk.
//
//   (b) The seed succeeded and the user later deleted the guide on purpose. The
//       standing non-negotiable is that deleting the guide must NOT resurrect it
//       on the next launch. These installs must be left alone.
//
// The marker value already distinguishes them, which is what makes this safe
// without a schema change:
//   * plain ISO timestamp        -> seeding SUCCEEDED  => case (b), do not heal
//   * "missing:<iso>"            -> PDF was not found  => case (a), heal
//   * "failed:<iso>:<error>"     -> ingest failed      => case (a), heal
//
// So self-heal fires only for markers that record a failure. That fixes every
// install caught by the upgrade bug while honoring the delete contract.
export function isFailedSeedMarker(value: string | null): boolean {
  if (value === null) return false;
  const v = value.trim().toLowerCase();
  return v.startsWith("missing:") || v.startsWith("failed:");
}

/** Persist the marker with the given ISO timestamp (or a marker "missing"). */
export function setWelcomeGuideMarker(rawDb: Database.Database, value: string): void {
  try {
    rawDb
      .prepare(
        `INSERT INTO app_settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(SEED_WELCOME_GUIDE_MARKER_KEY, value);
  } catch (err) {
    console.error(`${LOG_PREFIX} failed to write marker:`, err);
  }
}

/** Clear the marker. Not used by the standard boot path but handy for tests. */
export function clearWelcomeGuideMarker(rawDb: Database.Database): void {
  try {
    rawDb
      .prepare("DELETE FROM app_settings WHERE key = ?")
      .run(SEED_WELCOME_GUIDE_MARKER_KEY);
  } catch { /* ignore */ }
}

/**
 * Locate the bundled Welcome Guide PDF, checking (in order):
 *   1. env APD_WELCOME_GUIDE_PDF (explicit override for tests / dev)
 *   2. <runDir>/welcome-guide/AdvisePoint-Docs-Welcome-Guide.pdf
 *   3. <runDir>/resources/welcome-guide/AdvisePoint-Docs-Welcome-Guide.pdf
 *   4. <runDir>/../welcome-guide/AdvisePoint-Docs-Welcome-Guide.pdf
 *   5. <repoRoot>/packaging/welcome-guide/AdvisePoint-Docs-Welcome-Guide.pdf
 *      (dev-time convenience: server started from repo root)
 *
 * Returns the absolute path, or null when nothing readable was found.
 */
export function findWelcomeGuidePdf(): string | null {
  const explicit = process.env.APD_WELCOME_GUIDE_PDF;
  const fname = "AdvisePoint-Docs-Welcome-Guide.pdf";
  const runDir = process.cwd();
  const candidates: string[] = [];
  if (explicit) candidates.push(explicit);
  candidates.push(join(runDir, "welcome-guide", fname));
  candidates.push(join(runDir, "resources", "welcome-guide", fname));
  candidates.push(resolve(runDir, "..", "welcome-guide", fname));
  // Dev fallback: repo root packaging/ folder.
  candidates.push(resolve(runDir, "packaging", "welcome-guide", fname));
  for (const c of candidates) {
    try {
      if (existsSync(c)) {
        const st = statSync(c);
        if (st.isFile() && st.size > 0) return c;
      }
    } catch { /* keep trying */ }
  }
  return null;
}

export function readWelcomeGuideBytes(): { path: string; bytes: Buffer } | null {
  const p = findWelcomeGuidePdf();
  if (!p) return null;
  try {
    return { path: p, bytes: readFileSync(p) };
  } catch (err) {
    console.error(`${LOG_PREFIX} failed to read ${p}:`, err);
    return null;
  }
}

/** Metadata used for the seeded doc. Shared with the reinstall endpoint. */
export const WELCOME_GUIDE_METADATA = {
  id: SEED_WELCOME_GUIDE_DOC_ID,
  title: "AdvisePoint Docs \u2014 Welcome Guide",
  product_family: "AdvisePoint",
  product_model: "AdvisePoint Docs",
  // v1.1.4: was "user_manual", which is no longer a seeded type. The doc
  // type seeder is now invoked before this runs, so "user_guide" exists.
  document_type: "user_guide",
  file_name: "AdvisePoint-Docs-Welcome-Guide.pdf",
  tags: ["getting-started", "backup", "recovery", "welcome-guide"] as string[],
};

export { LOG_PREFIX as SEED_LOG_PREFIX };
