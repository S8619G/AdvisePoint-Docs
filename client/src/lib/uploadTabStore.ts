// v1.1.0 item 5 - Upload tab state store.
//
// The problem
//   Every top-level tab (Library, Query, Upload, Settings) is a route-
//   mounted component. Wouter unmounts the previous route when the user
//   switches tabs, so every local `useState` inside Upload was discarded.
//   Users would stage 5 files, fill in shared metadata, tab over to
//   Library to check a filename, come back - and the page was blank.
//   If a batch was uploading when they left, they could not see whether
//   it finished, whether it errored, or what was in it. Destructive to
//   workflow, reported as a v1.0.15 field bug.
//
// The fix
//   Same shape as tabStore/libraryTabStore: lift the state that survives
//   navigation into a module-level singleton store outside the React
//   tree, subscribe via useSyncExternalStore. Unmounting the Upload page
//   no longer touches the store, so remounting restores everything
//   (staged files, per-file metadata, shared metadata, mode, upload
//   progress, success cards).
//
//   The store also lets a still-running `runBatch()` loop keep writing
//   progress into the store after the page unmounts - the fetch promise
//   was already surviving unmount, but the React setState calls were
//   effectively noops once the component was gone. Backing them by the
//   store means "return to Upload while the batch runs" shows the true
//   current state without any stale render.
//
// Persistence
//   In-memory ONLY. No localStorage, no sessionStorage, no disk. Two
//   reasons: (1) staged `File` objects are not serializable, (2) staged
//   files carry PII the user may not want lingering across app restarts.
//   State resets cleanly on app restart, which matches the intended UX.
//
// What lives here vs what stays in useState
//   Here: the state that must survive a tab switch or drive the sidebar
//   badge. Field-by-field, this is what upload.tsx used to hold:
//     - shared metadata form
//     - staged FileEntry list (with the File blob)
//     - mode (batch-shared vs batch-perfile)
//     - pastedBody / pastedResult (paste-text ingest)
//     - uploadingKey / batchDone (batch loop status)
//     - completedUploads (success card history)
//   NOT here (still useState in upload.tsx):
//     - dragging (drag-over visual only, resets on remount is fine)
//     - AlertDialog confirmOpen flags (transient, per-dialog-instance)
//     - fileInput ref (DOM ref, always local)
//     - debouncedNames (derived from files, gets rehydrated on remount
//       via the same useEffect debounce)

import { createTabStore, useTabState } from "./tabStore";

// -----------------------------------------------------------------------------
// Types
//
// The definitions here MUST stay structurally identical to the ones in
// upload.tsx so useStoreField swaps in with no JSX or handler changes.
// If you widen a field there, widen it here too.
// -----------------------------------------------------------------------------

export interface UploadMeta {
  title: string;
  subtitle: string;
  document_type: string;
  audience: string[];
  product_family: string;
  product_model: string;
  product_version: string;
  firmware_version: string;
  release_channel: string;
  confidentiality: string;
  allowed_tenants: string;
  tags: string;
}

export type UploadFileStatus = "pending" | "uploading" | "done" | "error" | "skipped";

export interface UploadFileEntry {
  key: string;
  file: File; // NOT serializable - intentional; store is in-memory only.
  status: UploadFileStatus;
  message: string;
  result: any | null;
  meta: UploadMeta;
  expanded: boolean;
}

export type UploadMode = "batch-shared" | "batch-perfile";

export interface UploadTabState {
  shared: UploadMeta;
  files: UploadFileEntry[];
  mode: UploadMode;
  // v1.1.9: shared-mode auto-fix titles toggle. When true, runBatch calls
  // fixTitle on each filename and sends the confident result as that
  // file's title. When false (default), the server fills each Title from
  // the filename as it did in v1.1.8.
  autoFixTitles: boolean;
  pastedBody: string;
  pastedResult: any | null;
  uploadingKey: string | null;
  batchDone: boolean;
  completedUploads: any[];
}

// -----------------------------------------------------------------------------
// Initial state
//
// Kept as a factory so tests / future "clear all" callers can rebuild it
// without importing the store implementation.
// -----------------------------------------------------------------------------

export function emptyUploadMeta(product_model = ""): UploadMeta {
  return {
    title: "",
    subtitle: "",
    document_type: "document",
    audience: [],
    product_family: "",
    product_model,
    product_version: "",
    firmware_version: "",
    release_channel: "ga",
    confidentiality: "public",
    allowed_tenants: "",
    tags: "",
  };
}

const initialUploadTabState: UploadTabState = {
  shared: emptyUploadMeta(),
  files: [],
  mode: "batch-shared",
  autoFixTitles: false,
  pastedBody: "",
  pastedResult: null,
  uploadingKey: null,
  batchDone: false,
  completedUploads: [],
};

export const uploadTabStore = createTabStore<UploadTabState>(initialUploadTabState);

// -----------------------------------------------------------------------------
// Sidebar badge helper
//
// The top-nav Upload tab shows a small "uploads in progress" pill so the
// user can tell from any tab that background work is still running.
// Count is the number of files still pending or actively uploading; 0
// hides the badge. We include `pending` alongside `uploading` because
// during a batch the not-yet-started rows are also "in progress" from
// the user's point of view.
// -----------------------------------------------------------------------------

export function countUploadsInProgress(state: UploadTabState): number {
  // If nothing is actively uploading, the batch is not running - so
  // "pending" rows are just staged files the user hasn't uploaded yet,
  // not in-flight work. Only surface the badge while the batch loop is
  // live.
  if (state.uploadingKey === null) return 0;
  return state.files.filter((f) => f.status === "pending" || f.status === "uploading").length;
}

export function useUploadsInProgress(): number {
  return useTabState(uploadTabStore, countUploadsInProgress);
}
