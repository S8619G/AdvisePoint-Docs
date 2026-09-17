// -----------------------------------------------------------------------------
// selectMetaForFile — pure helper for the Upload tab's batch loop (v1.1.8)
// -----------------------------------------------------------------------------
//
// Extracted from client/src/pages/upload.tsx so the mode-to-meta mapping is
// testable in isolation. This exists as its own module because the v1.1.8
// fix repairs a defect that was invisible to every existing test: the pre-
// v1.1.8 line `isBatch ? emptyMeta() : shared` dropped staged per-file and
// shared metadata on every multi-file upload, and none of the helper tests
// covered runBatch's mode selection. Isolating the selection here means the
// regression cannot come back silently.
//
// STRUCTURALLY TYPED for testability. Rather than importing the full `Meta`
// / `UploadMode` types from upload.tsx (which would drag React and the
// entire page module into a helper module), this file declares its own
// minimal shape:
//
//   - `MetaLike` is any object -- callers pass their real Meta, which is a
//     superset.
//   - `UploadModeLike` is the literal union used by the Upload page. Kept
//     inline instead of imported to keep this module free of upstream
//     imports.
//
// The Upload page's real `Meta` / `UploadMode` types are assignment-
// compatible with these; TypeScript accepts them at the call site.
// -----------------------------------------------------------------------------

export type UploadModeLike = "batch-shared" | "batch-perfile";

/**
 * Choose the metadata block to POST for one file in the batch loop.
 *
 * v1.1.8: three modes, each sends what its UI advertises.
 *
 *   - Single file (isBatch === false)   -> shared block
 *   - Batch, mode === "batch-perfile"   -> this entry's own meta
 *   - Batch, mode === "batch-shared"    -> shared block
 *
 * Prior to v1.1.8 the batch branch unconditionally sent an empty meta,
 * which discarded both per-file cards (Fix Title, Detect type) and the
 * shared form. See the block comment in runBatch for the history.
 */
export function selectMetaForFile<M>(
  args: {
    isBatch: boolean;
    mode: UploadModeLike;
    entryMeta: M;
    shared: M;
  },
): M {
  const { isBatch, mode, entryMeta, shared } = args;
  if (!isBatch) return shared;
  if (mode === "batch-perfile") return entryMeta;
  return shared;
}
