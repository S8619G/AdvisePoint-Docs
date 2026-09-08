import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Save,
  Upload as UploadIcon,
  Loader2,
  Download,
  Clock,
  ShieldAlert,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

// v1.0.3 - Backup & Restore panel.
//
// Manual section:
//   * Export: POSTs to /api/backup/export with the current window.localStorage
//     payload so the resulting zip captures browser-side UI state too. The
//     browser saves the file with the server-supplied Content-Disposition
//     filename (`advisepoint-docs-backup-YYYYMMDD-HHMMSS.zip`).
//   * Import: file picker + Wipe/Merge radio + a modal confirm (Wipe is
//     destructive and needs a relaunch). POSTs multipart to
//     /api/backup/import.
//
// Automatic section (Option 2 - in-server scheduler):
//   * Reads/writes /api/backup/settings so any tab that opens the panel
//     reflects the live scheduler config. Off/Daily/Weekly cadence,
//     HH:MM time, folder path, retention count.
//   * Shows the last-run timestamp reported by the server so a user can
//     confirm scheduled backups are actually happening without hunting
//     through log files.
//
// Design notes:
//   * The Export flow reads localStorage synchronously and posts JSON,
//     but the SERVER streams the zip back. That means we can't use a
//     plain <a href> - we build the download client-side from the
//     response Blob and revoke the object URL when it's done. This is
//     the one place in the app where we accept the extra memory pressure
//     (the whole zip lands in RAM); the tradeoff is that we can attach a
//     JSON body with the localStorage contents.
//   * Alert dialogs guard both Wipe restore ("this will replace your
//     library") and any settings change that turns scheduled backups
//     ON for the first time (so the user knows where files will land).

type Cadence = "off" | "daily" | "weekly";
type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

interface BackupSettings {
  cadence: Cadence;
  time_hhmm: string;
  weekday: Weekday;
  folder: string;
  retention_count: number;
  last_run_started_at: string | null;
  last_run_finished_at: string | null;
  last_run_status: "success" | "failed" | null;
  last_run_error: string | null;
  last_backup_filename: string | null;
  next_run_at: string | null;
  // v1.0.4: current on-disk size of the DB + rendered pages (raw), and an
  // estimated size of the ZIP the next backup would produce (raw + 2%).
  // Server returns 0/0 when the sizes can't be stat'ed.
  current_backup_size_bytes?: number;
  current_backup_size_estimate_bytes?: number;
}

const DEFAULT_SETTINGS: BackupSettings = {
  cadence: "off",
  time_hhmm: "02:00",
  weekday: 0,
  folder: "",
  retention_count: 7,
  last_run_started_at: null,
  last_run_finished_at: null,
  last_run_status: null,
  last_run_error: null,
  last_backup_filename: null,
  next_run_at: null,
  current_backup_size_bytes: 0,
  current_backup_size_estimate_bytes: 0,
};

// v1.0.4: human-readable size for the backup-size disclosure. Rounds to
// KB / MB / GB with one decimal. Returns "unknown" when the server sent 0.
function fmtBytes(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return "unknown";
  const KB = 1024;
  const MB = KB * 1024;
  const GB = MB * 1024;
  if (bytes >= GB) return `${(bytes / GB).toFixed(2)} GB`;
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`;
  if (bytes >= KB) return `${(bytes / KB).toFixed(1)} KB`;
  return `${bytes} B`;
}

function fmtRel(iso: string | null): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t);
  return d.toLocaleString();
}

export function BackupPanel() {
  const { toast } = useToast();
  const [busy, setBusy] = useState<null | "export" | "import" | "save" | "runnow">(null);
  const [settings, setSettings] = useState<BackupSettings>(DEFAULT_SETTINGS);
  const [initialLoaded, setInitialLoaded] = useState(false);
  const [importMode, setImportMode] = useState<"wipe" | "merge">("merge");
  const [importFile, setImportFile] = useState<File | null>(null);
  const [showWipeConfirm, setShowWipeConfirm] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Fetch settings on mount + refresh every 30s so the last-run stamp stays
  // roughly current while the panel is open.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/backup/settings");
        if (!res.ok) return;
        const j = await res.json();
        if (!cancelled && j?.settings) {
          setSettings({ ...DEFAULT_SETTINGS, ...j.settings });
          setInitialLoaded(true);
        }
      } catch {
        /* transient */
      }
    };
    load();
    const iv = window.setInterval(load, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(iv);
    };
  }, []);

  const patchSetting = <K extends keyof BackupSettings>(key: K, value: BackupSettings[K]) => {
    setSettings((s) => ({ ...s, [key]: value }));
  };

  const saveSettings = async () => {
    setBusy("save");
    try {
      const res = await fetch("/api/backup/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          cadence: settings.cadence,
          time_hhmm: settings.time_hhmm,
          weekday: settings.weekday,
          folder: settings.folder,
          retention_count: settings.retention_count,
        }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setSettings({ ...DEFAULT_SETTINGS, ...j.settings });
      toast({
        title: "Backup settings saved",
        description:
          settings.cadence === "off"
            ? "Scheduled backups are turned off."
            : `Next scheduled run: ${fmtRel(j.settings.next_run_at)}.`,
      });
    } catch (err) {
      toast({
        title: "Save failed",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  };

  const doExport = async () => {
    setBusy("export");
    try {
      let ls = "";
      try {
        // Snapshot every localStorage key. This is small (kilobytes) even
        // in an app that stores viewer prefs and tab state.
        const bag: Record<string, string> = {};
        for (let i = 0; i < window.localStorage.length; i++) {
          const k = window.localStorage.key(i);
          if (k != null) bag[k] = window.localStorage.getItem(k) ?? "";
        }
        ls = JSON.stringify(bag);
      } catch {
        /* private-mode etc; skip */
      }
      const res = await fetch("/api/backup/export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ localStorage: ls }),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(t || `HTTP ${res.status}`);
      }
      // Extract filename from Content-Disposition if present.
      const cd = res.headers.get("content-disposition") || "";
      const m = cd.match(/filename="?([^";]+)"?/i);
      const filename = m ? m[1] : "advisepoint-docs-backup.zip";
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      toast({
        title: "Backup exported",
        description: `Saved as ${filename} in your Downloads folder.`,
      });
    } catch (err) {
      toast({
        title: "Export failed",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  };

  const startImport = () => {
    if (!importFile) {
      toast({ title: "Choose a backup zip first", variant: "destructive" });
      return;
    }
    if (importMode === "wipe") {
      setShowWipeConfirm(true);
      return;
    }
    void performImport();
  };

  const performImport = async () => {
    if (!importFile) return;
    setShowWipeConfirm(false);
    setBusy("import");
    try {
      const fd = new FormData();
      fd.append("file", importFile);
      fd.append("mode", importMode);
      const res = await fetch("/api/backup/import", { method: "POST", body: fd });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) throw new Error(j.error || `HTTP ${res.status}`);
      if (importMode === "wipe") {
        toast({
          title: "Backup restored",
          description:
            "Wipe & Replace complete. Close and relaunch AdvisePoint Docs so the new library takes effect.",
        });
      } else {
        const parts = [
          `${j.documents_imported ?? 0} documents`,
          `${j.chunks_imported ?? 0} excerpts`,
          `${j.pages_files_copied ?? 0} page files`,
        ];
        toast({
          title: "Merge complete",
          description: `Imported ${parts.join(", ")}. Duplicates were skipped.`,
        });
      }
      setImportFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (err) {
      toast({
        title: "Import failed",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  };

  const runBackupNow = async () => {
    setBusy("runnow");
    try {
      // No dedicated run-now endpoint; POST settings with same values but
      // send a special "run_now" flag. Simpler: use the export endpoint
      // targeting the scheduled folder. For MVP we just POST to
      // /api/backup/settings with `run_now: true` and let the server run
      // a scheduled backup right now.
      const res = await fetch("/api/backup/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ run_now: true }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || `HTTP ${res.status}`);
      if (j.settings) setSettings({ ...DEFAULT_SETTINGS, ...j.settings });
      toast({
        title: "Backup started",
        description: "A scheduled-style backup is running now. Refresh in a moment to see the result.",
      });
    } catch (err) {
      toast({
        title: "Run-now failed",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Card data-testid="panel-backup">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Save className="h-4 w-4" />
            Backup &amp; Restore
          </CardTitle>
          <CardDescription className="text-xs">
            Export a single-file backup zip containing the database, page
            images, and UI preferences. Restore replaces or merges into your
            current library. Scheduled backups run inside the local server
            whenever it is up.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Manual section */}
          <section className="space-y-3">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Manual backup
            </h4>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                onClick={doExport}
                disabled={busy !== null}
                size="sm"
                data-testid="button-backup-export"
              >
                {busy === "export" ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Exporting…
                  </>
                ) : (
                  <>
                    <Download className="mr-2 h-4 w-4" />
                    Export backup now
                  </>
                )}
              </Button>
              <span className="text-[11px] text-muted-foreground">
                Saves <code className="rounded bg-muted px-1 py-0.5">advisepoint-docs-backup-YYYYMMDD-HHMMSS.zip</code> to your Downloads folder.
              </span>
            </div>

            <div className="rounded-md border border-border/60 p-3 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Label htmlFor="backup-import-file" className="text-xs">Restore from backup</Label>
                <input
                  ref={fileInputRef}
                  id="backup-import-file"
                  type="file"
                  accept=".zip"
                  onChange={(e) => setImportFile(e.target.files?.[0] ?? null)}
                  className="text-xs file:mr-2 file:rounded file:border-0 file:bg-secondary file:px-2 file:py-1 file:text-xs"
                  data-testid="input-backup-import-file"
                />
              </div>
              <div className="flex flex-wrap items-center gap-4 text-xs">
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    name="import-mode"
                    value="merge"
                    checked={importMode === "merge"}
                    onChange={() => setImportMode("merge")}
                    data-testid="radio-import-merge"
                  />
                  <span>Merge (add new docs, skip duplicates)</span>
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    name="import-mode"
                    value="wipe"
                    checked={importMode === "wipe"}
                    onChange={() => setImportMode("wipe")}
                    data-testid="radio-import-wipe"
                  />
                  <span className="flex items-center gap-1">
                    Wipe &amp; Replace
                    <ShieldAlert className="h-3 w-3 text-destructive" aria-label="Destructive" />
                  </span>
                </label>
              </div>
              <div className="flex items-center gap-3">
                <Button
                  onClick={startImport}
                  disabled={busy !== null || !importFile}
                  size="sm"
                  variant="secondary"
                  data-testid="button-backup-import"
                >
                  {busy === "import" ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Restoring…
                    </>
                  ) : (
                    <>
                      <UploadIcon className="mr-2 h-4 w-4" />
                      Restore from backup
                    </>
                  )}
                </Button>
                <span className="text-[11px] text-muted-foreground">
                  Wipe &amp; Replace keeps a timestamped copy of the current data folder next to it so you can roll back.
                </span>
              </div>
            </div>
          </section>

          {/* Scheduled section */}
          <section className="space-y-3">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Scheduled backup
            </h4>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="backup-cadence" className="text-xs">Cadence</Label>
                <Select
                  value={settings.cadence}
                  onValueChange={(v) => patchSetting("cadence", v as Cadence)}
                >
                  <SelectTrigger id="backup-cadence" className="h-8 text-xs" data-testid="select-backup-cadence">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="off">Off</SelectItem>
                    <SelectItem value="daily">Daily</SelectItem>
                    <SelectItem value="weekly">Weekly</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="backup-time" className="text-xs">Run at (HH:MM, 24-hour, local)</Label>
                <Input
                  id="backup-time"
                  type="time"
                  value={settings.time_hhmm}
                  disabled={settings.cadence === "off"}
                  onChange={(e) => patchSetting("time_hhmm", e.target.value)}
                  className="h-8 text-xs"
                  data-testid="input-backup-time"
                />
              </div>
              {settings.cadence === "weekly" && (
                <div className="space-y-1.5">
                  <Label htmlFor="backup-weekday" className="text-xs">Weekday</Label>
                  <Select
                    value={String(settings.weekday)}
                    onValueChange={(v) => patchSetting("weekday", Number(v) as Weekday)}
                  >
                    <SelectTrigger id="backup-weekday" className="h-8 text-xs" data-testid="select-backup-weekday">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="0">Sunday</SelectItem>
                      <SelectItem value="1">Monday</SelectItem>
                      <SelectItem value="2">Tuesday</SelectItem>
                      <SelectItem value="3">Wednesday</SelectItem>
                      <SelectItem value="4">Thursday</SelectItem>
                      <SelectItem value="5">Friday</SelectItem>
                      <SelectItem value="6">Saturday</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div className="space-y-1.5">
                <Label htmlFor="backup-retention" className="text-xs">Retain how many backups?</Label>
                <Input
                  id="backup-retention"
                  type="number"
                  min={1}
                  max={365}
                  value={settings.retention_count}
                  onChange={(e) => patchSetting("retention_count", Math.max(1, Number(e.target.value) || 7))}
                  className="h-8 text-xs"
                  data-testid="input-backup-retention"
                />
                {/* v1.0.4: current backup size disclosure. Muted so it
                    reads as informational rather than an action. Shows
                    the estimated ZIP size (raw + 2%) and the raw content
                    size in parentheses so users can plan folder capacity
                    before turning on daily/weekly retention. */}
                <p
                  className="text-[11px] text-muted-foreground"
                  data-testid="text-backup-size"
                >
                  Current backup size: ~{fmtBytes(settings.current_backup_size_estimate_bytes)}
                  {(settings.current_backup_size_bytes ?? 0) > 0 && (
                    <> ({fmtBytes(settings.current_backup_size_bytes)} on disk)</>
                  )}
                </p>
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="backup-folder" className="text-xs">
                  Folder (leave blank for <code className="rounded bg-muted px-1 py-0.5">%LOCALAPPDATA%\AdvisePoint Docs\backups\</code>)
                </Label>
                <Input
                  id="backup-folder"
                  type="text"
                  placeholder="e.g. D:\Backups\AdvisePoint Docs"
                  value={settings.folder}
                  onChange={(e) => patchSetting("folder", e.target.value)}
                  className="h-8 font-mono text-xs"
                  data-testid="input-backup-folder"
                />
                {/* v1.0.5: informational tip. Not actively enforced -- users may
                    legitimately back up to a sync folder if they know what they
                    are doing. */}
                <p className="text-xs text-muted-foreground">
                  Tip: keep your backup folder outside OneDrive, Dropbox, and other cloud-sync locations — file locks during sync can corrupt backups mid-write.
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                onClick={saveSettings}
                disabled={busy !== null || !initialLoaded}
                size="sm"
                data-testid="button-backup-save-settings"
              >
                {busy === "save" ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Saving…
                  </>
                ) : (
                  "Save settings"
                )}
              </Button>
              <Button
                onClick={runBackupNow}
                disabled={busy !== null || settings.cadence === "off"}
                size="sm"
                variant="secondary"
                data-testid="button-backup-run-now"
              >
                {busy === "runnow" ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Starting…
                  </>
                ) : (
                  <>
                    <Clock className="mr-2 h-4 w-4" />
                    Run scheduled backup now
                  </>
                )}
              </Button>
              <span className="text-[11px] text-muted-foreground">
                Runs only while the local server is up. Close the app, no backup.
              </span>
            </div>

            <div className="rounded-md bg-muted/40 p-2 text-[11px] leading-relaxed text-muted-foreground">
              <div>
                <span className="text-foreground">Last run:</span>{" "}
                {settings.last_run_finished_at ? (
                  <>
                    {fmtRel(settings.last_run_finished_at)}
                    {" — "}
                    <span
                      className={
                        settings.last_run_status === "success"
                          ? "text-emerald-500"
                          : settings.last_run_status === "failed"
                            ? "text-destructive"
                            : ""
                      }
                    >
                      {settings.last_run_status ?? "unknown"}
                    </span>
                    {settings.last_backup_filename && (
                      <>
                        {" — "}
                        <code className="rounded bg-background px-1 py-0.5 font-mono">
                          {settings.last_backup_filename}
                        </code>
                      </>
                    )}
                    {settings.last_run_status === "failed" && settings.last_run_error && (
                      <div className="mt-1 text-destructive">{settings.last_run_error}</div>
                    )}
                  </>
                ) : (
                  "never"
                )}
              </div>
              <div>
                <span className="text-foreground">Next run:</span>{" "}
                {settings.cadence === "off" ? "off" : fmtRel(settings.next_run_at)}
              </div>
            </div>
          </section>
        </CardContent>
      </Card>

      <AlertDialog open={showWipeConfirm} onOpenChange={setShowWipeConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Wipe &amp; Replace this library?</AlertDialogTitle>
            <AlertDialogDescription>
              Your current database and page images will be renamed with a{" "}
              <code>.bak-&lt;timestamp&gt;</code> suffix, then replaced with the contents of the
              selected backup zip. You will need to close and relaunch AdvisePoint Docs so the
              new library takes effect.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-wipe-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void performImport()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-wipe-confirm"
            >
              Yes, wipe &amp; replace
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
