import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FileArchive, Loader2, Download } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

// v0.9.31 - Diagnostics bundle export panel (Settings > About tab).
//
// One click packages the current + previous server log files, together with
// a bundle-info.txt snapshot (app version, OS, DB row counts, memory), into
// a timestamped zip saved to the user's Downloads folder. The zip is meant
// to be attached to a support request so a maintainer can inspect the same
// session state the user was in when the issue happened.
//
// We drive the download by creating a temporary <a> pointing at the API
// route with the `download` attribute, clicking it, and immediately
// removing it. This keeps the browser in charge of file naming and target
// location (Save-As dialogs still work) and avoids any XHR-decode-then-
// Blob-URL dance that would only run into CORS/streaming edge cases. The
// filename is set server-side via Content-Disposition, so the anchor's
// `download` attribute is only a hint.
//
// A short "busy" state guards against double-clicks - the server takes a
// few milliseconds to zip up a typical log pair but the browser can still
// enqueue multiple downloads if the user is impatient.
export function DiagnosticsPanel() {
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();

  const exportLogs = () => {
    setBusy(true);
    try {
      const a = document.createElement("a");
      a.href = "/api/diagnostics/export";
      // download="" is only a hint; the server sets a timestamped filename
      // via Content-Disposition. Setting a value here anyway means a
      // browser that ignores the header still produces something usable.
      a.download = "advisepoint-docs-diagnostics.zip";
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      toast({
        title: "Diagnostics bundle exported",
        description: "Saved to your Downloads folder. Attach it to your support request.",
      });
    } catch (err) {
      toast({
        title: "Export failed",
        description: err instanceof Error ? err.message : "The download could not be started.",
        variant: "destructive",
      });
    } finally {
      // Release the button quickly - the browser owns the download from
      // the click event forward. If we kept `busy=true` until the file
      // finished writing we'd need to poll something meaningless.
      setTimeout(() => setBusy(false), 500);
    }
  };

  return (
    <Card data-testid="panel-diagnostics">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <FileArchive className="h-4 w-4" />
          Diagnostics
        </CardTitle>
        <CardDescription className="text-xs">
          Bundles the last two server log files and system info into a zip in your Downloads folder. Attach it to a
          support request so the current session can be analyzed.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-3">
          <Button
            onClick={exportLogs}
            disabled={busy}
            size="sm"
            data-testid="button-export-logs"
          >
            {busy ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Preparing…
              </>
            ) : (
              <>
                <Download className="mr-2 h-4 w-4" />
                Export logs for analysis
              </>
            )}
          </Button>
          <span className="text-[11px] text-muted-foreground">
            Includes <code className="rounded bg-muted px-1 py-0.5">server.log</code>,{" "}
            <code className="rounded bg-muted px-1 py-0.5">server.log.1</code>, and{" "}
            <code className="rounded bg-muted px-1 py-0.5">bundle-info.txt</code>.
          </span>
        </div>
        <p className="text-[11px] text-muted-foreground">
          The database file, page images, and any uploaded PDFs are <span className="font-medium">not</span>{" "}
          included in the zip.
        </p>
      </CardContent>
    </Card>
  );
}
