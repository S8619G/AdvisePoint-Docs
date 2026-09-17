import { useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ArchiveRestore, X } from "lucide-react";

// v1.2.3: first-launch banner surfaced after a wipe-restore, and as a
// backstop for merge-restores whose inline modal the user dismissed
// via a hard close before it opened. The record is delivered by
// GET /api/backup/restore-banner, which READS-AND-CLEARS the server-
// side side-file in one call, so the banner surfaces at most once
// per restore.
//
// WHY THE READ-AND-CLEAR IS SERVER-SIDE
// If the client cleared the record after rendering, a client crash
// between the read and the clear would loop the banner. Consuming the
// record in the same server call the client made to see it means the
// side-file is gone before the banner ever paints, which is the
// correct semantic ("we told the user"). If the user closes the app
// before dismissing the banner, that is fine -- the record has served
// its purpose. If they never come back to a page that renders this
// banner, the record has still served its purpose because the inline
// modal fired first.
//
// The banner deliberately duplicates the modal copy so a user who
// missed the inline modal (or restarted before seeing it) gets the
// same message.

interface BannerRecord {
  at: string;
  mode: "wipe" | "merge";
  source: string | null;
  documents: number | null;
  chunks: number | null;
  bak_dir: string | null;
  v: 1;
}

export function RestoreFirstLaunchBanner() {
  const [record, setRecord] = useState<BannerRecord | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/backup/restore-banner");
        if (!res.ok) return;
        const body = await res.json();
        if (cancelled) return;
        if (body?.record) {
          setRecord(body.record as BannerRecord);
        }
      } catch {
        // Endpoint absent or transient failure. Nothing to render.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!record || dismissed) return null;

  const when = new Date(record.at);
  const whenLabel = Number.isFinite(when.getTime())
    ? when.toLocaleString()
    : record.at;

  return (
    <Alert className="border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
      <ArchiveRestore className="h-4 w-4" />
      <AlertTitle className="flex items-center justify-between gap-2">
        <span>
          Restore completed {record.mode === "wipe" ? "\u2014 library replaced" : "\u2014 merged into existing library"}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-2 text-xs text-inherit hover:bg-amber-100 dark:hover:bg-amber-950/60"
          onClick={() => setDismissed(true)}
          data-testid="button-restore-banner-dismiss"
        >
          <X className="h-3.5 w-3.5" />
          Dismiss
        </Button>
      </AlertTitle>
      <AlertDescription>
        <div className="space-y-2 text-xs">
          <p>
            {record.mode === "wipe" ? (
              <>
                On {whenLabel}, the library was replaced from{" "}
                <span className="font-medium">{record.source ?? "a backup"}</span>
                {typeof record.documents === "number" ? (
                  <>
                    {" "}({record.documents} document{record.documents === 1 ? "" : "s"}
                    {typeof record.chunks === "number" ? `, ${record.chunks} chunk${record.chunks === 1 ? "" : "s"}` : ""})
                  </>
                ) : null}
                .
              </>
            ) : (
              <>
                On {whenLabel}, a merge restore from{" "}
                <span className="font-medium">{record.source ?? "a backup"}</span> added its contents to your existing library.
              </>
            )}
          </p>
          {record.bak_dir ? (
            <div className="rounded-md border border-amber-300/60 bg-white/60 p-2 dark:border-amber-900/60 dark:bg-black/20">
              <div className="text-[10px] uppercase tracking-wider">Pre-restore snapshot</div>
              <code className="break-all text-[11px]">{record.bak_dir}</code>
              <p className="mt-1">
                This folder is not deleted automatically. To roll back to the pre-restore state, close AdvisePoint Docs, rename this folder over the current data folder, and restart.
              </p>
            </div>
          ) : null}
          <p>
            Heads up: Recovery &rarr; <span className="font-medium">Delete all</span> operates on the library as it exists <em>now</em>. It removes what this restore added; it does not undo the restore. Use the snapshot above for that.
          </p>
        </div>
      </AlertDescription>
    </Alert>
  );
}

export default RestoreFirstLaunchBanner;
