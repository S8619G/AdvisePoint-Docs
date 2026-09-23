import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogCancel,
} from "@/components/ui/alert-dialog";

export function StopApplicationButton() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function stop() {
    setBusy(true); setError("");
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch("/api/system/stop", {
        method: "POST", headers: { "Content-Type": "application/json", "X-APD-Stop": "1" },
        body: JSON.stringify({ confirm: true }), signal: controller.signal,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || "The application could not be stopped.");
      window.dispatchEvent(new Event("apd-application-stopped"));
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Stop failed. Check the connection and retry.");
    } finally { window.clearTimeout(timeout); setBusy(false); }
  }
  return <div className="border-t pt-3 space-y-2">
    <p className="text-xs text-muted-foreground">
      Closing the browser leaves the local service running.
    </p>
    <Button variant="outline" size="sm" data-testid="button-stop-application"
      onClick={() => { setError(""); setOpen(true); }}>Stop application</Button>
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Stop AdvisePoint Docs?</AlertDialogTitle>
          <AlertDialogDescription>
            This stops the local service for all open tabs. Finish uploads, printing,
            external edits and backups first. No library data is deleted.
            Scheduled backups pause until the app is started again.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <Button disabled={busy} onClick={stop} data-testid="button-confirm-stop">
            {busy ? "Stopping…" : "Stop application"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>;
}
