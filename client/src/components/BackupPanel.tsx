import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  FolderOpen,
  HardDrive,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  RefreshCw,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { setBusy } from "@/lib/queryClient";
import { useQueryClient } from "@tanstack/react-query";

// v1.0.14: localStorage keys for "last folder the user picked" per field.
// Read by the native folder picker as a fallback when the current text-box
// value is empty. Kept in one place so the two Browse buttons can't drift.
const LAST_FOLDER_QUICK_KEY = "advisepoint-docs.backup.last-folder.quick";
const LAST_FOLDER_SCHEDULED_KEY = "advisepoint-docs.backup.last-folder.scheduled";

// v1.0.11 -- Backup & Restore panel, three-column redesign.
//
// The three cards are peers: each has its own header, its own destination
// (or source file), its own action buttons, and its own status area. No
// cross-column status bar. This shape came out of a design discussion
// where users wanted a scan-once layout that makes it obvious which
// action affects which drive.
//
//   Column 1 -- Quick backup:
//     * Destination folder + Browse button (in-app path builder that
//       lists available Windows drives so a folder can be picked
//       without leaving the app).
//     * Live preflight strip: drive present, writable, free vs needed,
//       cloud-sync warning.
//     * One "Back up now" button. Grayed until preflight is green (or
//       amber with acknowledgement). Streams the resulting ZIP to the
//       browser and downloads it; the folder input just seeds the
//       download filename hint -- writing to a user-picked local path
//       is not possible from a browser without File System Access.
//
//   Column 2 -- Scheduled backups:
//     * Destination folder + Browse button (independent of Column 1).
//     * Cadence / time / weekday / retention.
//     * "Save schedule" button that POSTs the settings.
//     * "Back up now" button that fires an immediate scheduled-style
//       run against the scheduled folder (so a user turning on
//       scheduled backups for the first time can get a baseline
//       without waiting for 2 AM).
//     * Bottom blurb: last-run time + status + size, plus next-run
//       estimate. A failed last run becomes a persistent amber banner
//       above the row with a Try again action.
//
//   Column 3 -- Restore from backup:
//     * File picker + a "How to restore" radio (Wipe / Merge).
//     * "Restore now" button. Wipe still needs the alert-dialog
//       confirmation from the previous release.

type Cadence = "off" | "daily" | "weekly";
type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

// -------- Types mirroring the server's wire shape --------

interface BackupSettingsWire {
  cadence: Cadence;
  time: string;
  time_hhmm: string;
  folder: string;
  retention: number;
  retention_count: number;
  weekday: number;
  last_run_started_at: string | null;
  last_run_finished_at: string | null;
  last_run_status: "success" | "failed" | null;
  last_run_error: string | null;
  last_run_error_detail: {
    title: string | null;
    cause: string | null;
    next_action: string | null;
    kind: string | null;
    raw: string;
  } | null;
  last_backup_filename: string | null;
  next_run_at: string | null;
  lastBytes: number | null;
  current_backup_size_bytes: number | null;
  current_backup_size_estimate_bytes: number | null;
}

interface PreflightResult {
  ok: boolean;
  ready: boolean;
  present: boolean;
  writable: boolean;
  low_space: boolean;
  free_bytes: number | null;
  needed_bytes: number | null;
  cloud_provider: null | "onedrive" | "dropbox" | "google-drive" | "icloud" | "box";
  // v1.0.12.4: the chosen folder is inside the app's own data directory.
  inside_data_dir?: boolean;
  detail: {
    title: string;
    cause: string;
    next_action: string;
    kind: string;
  } | null;
}

interface DrivesResponse {
  ok: boolean;
  drives: Array<{ letter: string; root: string; label: string | null }>;
  platform: string;
}

// -------- Formatters --------

function formatBytes(n: number | null | undefined): string {
  if (n == null || !isFinite(n) || n < 0) return "unknown";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

// -------- Component --------

export function BackupPanel() {
  const { toast } = useToast();

  // Server-persisted settings (Column 2). Loaded from /api/backup/settings.
  const [settings, setSettings] = useState<BackupSettingsWire | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(true);
  // Size info arrives separately from /api/backup/size so opening the panel
  // isn't blocked by a directory walk on machines with lots of pages.
  const [sizeBytes, setSizeBytes] = useState<number | null>(null);
  const [sizeEstimate, setSizeEstimate] = useState<number | null>(null);

  // Column 1 (Quick backup) state.
  const [quickFolder, setQuickFolder] = useState("");
  const [quickPreflight, setQuickPreflight] = useState<PreflightResult | null>(null);
  const [quickPreflightLoading, setQuickPreflightLoading] = useState(false);
  const [quickCloudAck, setQuickCloudAck] = useState(false);
  const [quickInFlight, setQuickInFlight] = useState(false);

  // Column 2 (Scheduled) draft state -- mirrors settings but is edited
  // locally until the user clicks Save.
  const [scheduledFolder, setScheduledFolder] = useState("");
  const [scheduledCadence, setScheduledCadence] = useState<Cadence>("off");
  const [scheduledTime, setScheduledTime] = useState("02:00");
  const [scheduledRetention, setScheduledRetention] = useState(7);
  const [scheduledWeekday, setScheduledWeekday] = useState<Weekday>(0);
  const [scheduledDirty, setScheduledDirty] = useState(false);
  const [scheduledSaving, setScheduledSaving] = useState(false);
  const [scheduledRunning, setScheduledRunning] = useState(false);
  const [scheduledPreflight, setScheduledPreflight] = useState<PreflightResult | null>(null);
  const [scheduledPreflightLoading, setScheduledPreflightLoading] = useState(false);
  const [scheduledCloudAck, setScheduledCloudAck] = useState(false);

  // Column 3 (Restore) state.
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restoreMode, setRestoreMode] = useState<"wipe" | "merge">("merge");
  const [restoreRunning, setRestoreRunning] = useState(false);
  const [wipeConfirmOpen, setWipeConfirmOpen] = useState(false);
  const restoreInputRef = useRef<HTMLInputElement | null>(null);

  // v1.2.3: inline post-restore modal. Shown as soon as a restore
  // succeeds, so the user sees the guidance without hunting for the
  // toast. The banner-later half of the same signal is driven from
  // /api/backup/restore-banner and lives in RestoreFirstLaunchBanner.
  // We keep both surfaces backed by the same server-side side-file so
  // if the app is force-closed before the modal is dismissed, the
  // banner picks it up on the next launch.
  const [postRestoreOpen, setPostRestoreOpen] = useState(false);
  const [postRestoreInfo, setPostRestoreInfo] = useState<{
    mode: "wipe" | "merge";
    source: string;
    documents: number | null;
    chunks: number | null;
    bak_dir: string | null;
  } | null>(null);

  // Drive picker (shared across Column 1 & Column 2).
  const [drives, setDrives] = useState<DrivesResponse["drives"]>([]);
  const [pickerOpen, setPickerOpen] = useState<null | "quick" | "scheduled">(null);
  const [pickerPath, setPickerPath] = useState("");
  // v1.0.14: react-query invalidation for Library/stats after a successful
  // restore. Kept in scope so the restore paths below can trigger a refresh
  // without a manual page reload.
  const qc = useQueryClient();
  const invalidateLibraryCaches = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["/api/documents"] });
    qc.invalidateQueries({ queryKey: ["/api/stats"] });
    qc.invalidateQueries({ queryKey: ["/api/facets"] });
  }, [qc]);

  // v1.0.14: Native folder picker helper.
  //
  // On Windows the server opens a real FolderBrowserDialog and returns
  // the chosen path. On other platforms (Linux test box, macOS dev) it
  // returns `{ unsupported: true }` and we fall back to the existing
  // in-app drive-list picker so the button always does *something*.
  //
  // Seed order: current text-box value -> last folder picked for this
  // field -> Documents (the OS's usual default when no path is given).
  const openBrowseFolder = useCallback(async (
    which: "quick" | "scheduled",
    currentValue: string,
    onPicked: (path: string) => void,
  ) => {
    const lastKey = which === "quick" ? LAST_FOLDER_QUICK_KEY : LAST_FOLDER_SCHEDULED_KEY;
    let seed = (currentValue || "").trim();
    if (!seed) {
      try { seed = localStorage.getItem(lastKey) || ""; } catch { seed = ""; }
    }
    try {
      const r = await fetch("/api/backup/browse-folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start_at: seed }),
      });
      const j = await r.json();
      if (j?.ok && typeof j.path === "string" && j.path) {
        try { localStorage.setItem(lastKey, j.path); } catch { /* ignore quota */ }
        onPicked(j.path);
        return;
      }
      if (j?.ok && j.cancelled) {
        // User closed the dialog -- do nothing, don't open the fallback.
        return;
      }
      // unsupported (non-Windows) or a server-side failure -- fall back
      // to the drive-list picker so the button still works during dev
      // and testing on Linux/macOS.
      setPickerPath(currentValue);
      setPickerOpen(which);
    } catch {
      // Network error -- same fallback as above.
      setPickerPath(currentValue);
      setPickerOpen(which);
    }
  }, []);

  // v1.0.11.2: persistent last-operation strips for Quick backup and
  // Restore, matching the scheduled-backup card. Read from
  // /api/backup/lastop on mount and refreshed after each op.
  interface LastOpQuickBackup { at: string | null; status: "success" | "failed" | null; path: string | null; bytes: number | null; error: string | null; }
  interface LastOpRestore { at: string | null; status: "success" | "failed" | null; source: string | null; error: string | null; }
  const [lastQuickBackup, setLastQuickBackup] = useState<LastOpQuickBackup | null>(null);
  const [lastRestore, setLastRestore] = useState<LastOpRestore | null>(null);

  const loadLastOps = useCallback(async () => {
    try {
      const r = await fetch("/api/backup/lastop");
      const j = await r.json();
      if (j?.ok) {
        if (j.quick_backup) setLastQuickBackup(j.quick_backup as LastOpQuickBackup);
        if (j.restore) setLastRestore(j.restore as LastOpRestore);
      }
    } catch { /* non-fatal */ }
  }, []);

  // -------- Fetch settings + size on mount --------

  const loadSettings = useCallback(async () => {
    setSettingsLoading(true);
    try {
      const r = await fetch("/api/backup/settings");
      const j = await r.json();
      if (j?.ok && j.settings) {
        const s = j.settings as BackupSettingsWire;
        setSettings(s);
        setScheduledFolder(s.folder);
        setScheduledCadence(s.cadence);
        setScheduledTime(s.time_hhmm ?? s.time ?? "02:00");
        setScheduledRetention(s.retention_count ?? s.retention ?? 7);
        setScheduledWeekday((s.weekday ?? 0) as Weekday);
        // Seed the Quick backup folder to the scheduled folder as a
        // reasonable default; users often want the ZIP in the same
        // place. They can change it before hitting Back up now.
        setQuickFolder((prev) => prev || s.folder);
        setScheduledDirty(false);
      }
    } catch (err) {
      toast({
        title: "Couldn't load backup settings",
        description: "Try reopening this panel. If it keeps failing, restart the app.",
        variant: "destructive",
      });
    } finally {
      setSettingsLoading(false);
    }
  }, [toast]);

  const loadSize = useCallback(async () => {
    try {
      const r = await fetch("/api/backup/size");
      const j = await r.json();
      if (j?.ok) {
        setSizeBytes(typeof j.current_backup_size_bytes === "number" ? j.current_backup_size_bytes : null);
        setSizeEstimate(typeof j.current_backup_size_estimate_bytes === "number" ? j.current_backup_size_estimate_bytes : null);
      }
    } catch {
      // Non-fatal -- the muted line will read "unknown"
    }
  }, []);
  // -------- v1.0.11.4: Duplicate documents cleanup --------

  // v1.0.11.1: separate loading state so the picker's Refresh button can
  // show a spinner while the async probe runs on the server.
  const [drivesLoading, setDrivesLoading] = useState(false);
  const loadDrives = useCallback(async () => {
    setDrivesLoading(true);
    try {
      const r = await fetch("/api/backup/drives");
      const j: DrivesResponse = await r.json();
      if (j?.ok) setDrives(j.drives || []);
    } catch { /* non-fatal */ }
    finally { setDrivesLoading(false); }
  }, []);

  useEffect(() => {
    void loadSettings();
    void loadSize();
    void loadDrives();
    void loadLastOps();
  }, [loadSettings, loadSize, loadDrives, loadLastOps]);

  // v1.0.11.2: auto-run preflight whenever the Quick backup folder
  // changes (typed, pasted, or picked). Previously preflight only ran
  // on blur or when the folder was chosen through Browse -> Use this
  // folder, so a preselected or manually-typed folder left Backup Now
  // grayed out until the user did the picker dance. Debounced to avoid
  // firing on every keystroke while still turning the button green
  // within a beat of the user pausing.
  useEffect(() => {
    const folder = quickFolder.trim();
    if (!folder) return;
    const t = setTimeout(() => {
      void runPreflight(folder, setQuickPreflight, setQuickPreflightLoading);
    }, 250);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quickFolder]);

  // Same for the scheduled folder input.
  useEffect(() => {
    const folder = scheduledFolder.trim();
    if (!folder) return;
    const t = setTimeout(() => {
      void runPreflight(folder, setScheduledPreflight, setScheduledPreflightLoading);
    }, 250);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduledFolder]);

  // v1.0.11.1: refetch drives when the browser tab regains focus or
  // becomes visible again -- the common case for a user returning after
  // plugging in an external drive. `focus` fires on window activation
  // and `visibilitychange` fires on tab switches; both are cheap and
  // the drives probe is now bounded so extra calls won't stall the
  // event loop. We still avoid polling on an interval; user-triggered
  // and lifecycle-triggered refreshes are enough.
  useEffect(() => {
    const onFocus = () => { void loadDrives(); };
    const onVisibility = () => { if (document.visibilityState === "visible") void loadDrives(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [loadDrives]);

  // Poll for scheduled-run completion so the "Back up now" button in
  // Column 2 flips back to idle when the async run finishes.
  useEffect(() => {
    if (!scheduledRunning) return;
    const iv = setInterval(async () => {
      try {
        const r = await fetch("/api/backup/settings");
        const j = await r.json();
        if (j?.ok && j.settings) {
          const s = j.settings as BackupSettingsWire;
          setSettings(s);
          // Consider the run finished if the last-run status is fresh
          // (within the last 3 minutes) -- the scheduler updates it at
          // both success and failure.
          if (s.last_run_finished_at) {
            const age = Date.now() - new Date(s.last_run_finished_at).getTime();
            if (age >= 0 && age < 3 * 60 * 1000) {
              setScheduledRunning(false);
              if (s.last_run_status === "success") {
                toast({
                  title: "Scheduled backup finished",
                  description: s.last_backup_filename
                    ? `Wrote ${s.last_backup_filename}`
                    : "Backup written.",
                });
              } else if (s.last_run_status === "failed") {
                toast({
                  title: s.last_run_error_detail?.title || "Scheduled backup failed",
                  description: s.last_run_error_detail?.next_action || "See the banner in the Scheduled backups card.",
                  variant: "destructive",
                });
              }
            }
          }
        }
      } catch { /* keep polling */ }
    }, 5000);
    return () => clearInterval(iv);
  }, [scheduledRunning, toast]);

  // -------- Preflight --------

  const runPreflight = useCallback(async (
    folder: string,
    setResult: (r: PreflightResult | null) => void,
    setLoading: (b: boolean) => void,
  ) => {
    if (!folder || !folder.trim()) {
      setResult(null);
      return;
    }
    setLoading(true);
    try {
      const r = await fetch("/api/backup/preflight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folder, needed_bytes: sizeEstimate ?? undefined }),
      });
      const j = await r.json();
      setResult(j as PreflightResult);
    } catch {
      setResult({
        ok: false,
        ready: false,
        present: false,
        writable: false,
        low_space: false,
        free_bytes: null,
        needed_bytes: null,
        cloud_provider: null,
        inside_data_dir: false,
        detail: {
          title: "Couldn't check that folder",
          cause: "AdvisePoint Docs couldn't reach its own server to check the folder.",
          next_action: "Try again in a moment; if it keeps failing, restart the app.",
          kind: "unknown",
        },
      });
    } finally {
      setLoading(false);
    }
  }, [sizeEstimate]);

  // -------- Actions --------

  // v1.0.11.1: Manual "Back up now" writes to the selected folder on
  // disk via the new /api/backup/export-to-folder endpoint. The server
  // runs preflight against the folder first and refuses the write on
  // any failed check, so the client's own preflight gate is a
  // secondary guard rather than the only one. The success toast
  // reports the full path written -- previously the client used the
  // browser Downloads folder regardless of what the user chose, and
  // never surfaced the actual destination.
  async function onQuickBackup() {
    if (quickInFlight) return;
    const folder = quickFolder.trim();
    if (!folder) {
      toast({
        title: "Choose a folder first",
        description: "Pick a mounted drive and folder before backing up.",
        variant: "destructive",
      });
      return;
    }
    setQuickInFlight(true);
    // v1.0.11.2: silence the reconnect banner while a manual backup
    // runs. The server is single-threaded so /api/health can miss its
    // 3.5s deadline during a big export; that stall is expected here.
    setBusy(true);
    try {
      let lsJson = "";
      try { lsJson = JSON.stringify({ ...window.localStorage }); } catch { /* ignore */ }
      const r = await fetch("/api/backup/export-to-folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folder, localStorage: lsJson }),
      });
      const j = await r.json().catch(() => null as unknown as { ok?: boolean });
      if (!r.ok || !j?.ok) {
        const detail = (j as { detail?: { title?: string; next_action?: string; cause?: string } } | null)?.detail;
        const title = detail?.title
          || (typeof (j as { error?: string } | null)?.error === "string" ? ((j as { error?: string }).error as string) : "Backup couldn't finish");
        const description = detail?.next_action || detail?.cause || "Try again in a moment.";
        toast({ title, description, variant: "destructive" });
        return;
      }
      const written = (j as { path?: string; bytes?: number; filename?: string });
      toast({
        title: "Backup written",
        description: written.path
          ? `Wrote ${written.path}${typeof written.bytes === "number" ? ` (${formatBytes(written.bytes)})` : ""}`
          : `Saved ${written.filename ?? "backup"}`,
      });
      void loadSize();
      void loadLastOps();
    } catch {
      toast({
        title: "Backup couldn't start",
        description: "The app couldn't reach its own server. Try restarting.",
        variant: "destructive",
      });
      void loadLastOps();
    } finally {
      setBusy(false);
      setQuickInFlight(false);
    }
  }

  // v1.0.11.1: "Download a copy" -- explicit browser-download action,
  // kept separate from the main "Back up now" button. Streams the ZIP
  // response body directly to a File System Access save target when
  // available, and falls back to blob URL + anchor click when not.
  // Either way, we avoid awaiting r.blob() so the archive never has to
  // fit in browser memory at once.
  const [downloadInFlight, setDownloadInFlight] = useState(false);
  async function onDownloadCopy() {
    if (downloadInFlight) return;
    setDownloadInFlight(true);
    setBusy(true);
    try {
      let lsJson = "";
      try { lsJson = JSON.stringify({ ...window.localStorage }); } catch { /* ignore */ }
      const r = await fetch("/api/backup/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ localStorage: lsJson }),
      });
      if (!r.ok) {
        let title = "Download couldn't finish";
        let description = "Try again in a moment.";
        try {
          const j = await r.json();
          if (j?.detail?.title) title = j.detail.title;
          if (j?.detail?.next_action) description = j.detail.next_action;
          else if (j?.detail?.cause) description = j.detail.cause;
          else if (typeof j?.error === "string") title = j.error;
        } catch { /* keep defaults */ }
        toast({ title, description, variant: "destructive" });
        return;
      }
      const disposition = r.headers.get("Content-Disposition") || "";
      const nameMatch = /filename="([^"]+)"/.exec(disposition);
      const filename = nameMatch?.[1] || "advisepoint-docs-backup.zip";

      // Preferred path: File System Access API. Streams the response
      // body into a chosen file with no in-memory buffering.
      const showSaveFilePicker = (window as unknown as {
        showSaveFilePicker?: (opts?: unknown) => Promise<FileSystemFileHandle>;
      }).showSaveFilePicker;
      if (typeof showSaveFilePicker === "function" && r.body) {
        try {
          const handle = await showSaveFilePicker({
            suggestedName: filename,
            types: [{ description: "Backup ZIP", accept: { "application/zip": [".zip"] } }],
          });
          const w = await handle.createWritable();
          await r.body.pipeTo(w);
          toast({ title: "Download saved", description: `Saved ${filename}` });
          return;
        } catch (err) {
          // User cancelled or the picker isn't allowed in this context.
          // Fall through to the blob-URL fallback below.
          if ((err as { name?: string })?.name === "AbortError") {
            return;
          }
        }
      }

      // Fallback: blob URL + anchor click. Buffers in memory; unavoidable
      // in browsers without the File System Access API.
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast({ title: "Download ready", description: `Saved ${filename} (${formatBytes(blob.size)})` });
    } catch {
      toast({
        title: "Download couldn't start",
        description: "The app couldn't reach its own server. Try restarting.",
        variant: "destructive",
      });
    } finally {
      setBusy(false);
      setDownloadInFlight(false);
    }
  }

  async function onSaveSchedule() {
    // v1.0.12.4: a schedule with no destination silently never runs. There is
    // no default folder to fall back on, so refuse the save instead.
    if (scheduledCadence !== "off" && !scheduledFolder.trim()) {
      toast({
        title: "Choose a backup folder first",
        description:
          "Scheduled backups need a destination. Pick a folder -- ideally on a different drive from the app.",
        variant: "destructive",
      });
      return;
    }
    setScheduledSaving(true);
    try {
      const r = await fetch("/api/backup/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cadence: scheduledCadence,
          time_hhmm: scheduledTime,
          folder: scheduledFolder,
          retention_count: scheduledRetention,
          weekday: scheduledWeekday,
        }),
      });
      const j = await r.json();
      if (!j?.ok) {
        toast({
          title: "Couldn't save the schedule",
          description: j?.error || "Try again in a moment.",
          variant: "destructive",
        });
        return;
      }
      setSettings(j.settings);
      setScheduledDirty(false);
      toast({ title: "Schedule saved", description:
        scheduledCadence === "off"
          ? "Scheduled backups are off."
          : `Next backup ${scheduledCadence} at ${scheduledTime}.`,
      });
    } finally {
      setScheduledSaving(false);
    }
  }

  async function onRunScheduledNow() {
    if (scheduledRunning) return;
    setScheduledRunning(true);
    try {
      const r = await fetch("/api/backup/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // Send the currently-saved values so the run uses whatever
          // the user has committed, not their in-progress edits.
          folder: settings?.folder ?? scheduledFolder,
          run_now: true,
        }),
      });
      const j = await r.json();
      if (!j?.ok) {
        setScheduledRunning(false);
        toast({
          title: "Couldn't start the backup",
          description: j?.error || "Try again in a moment.",
          variant: "destructive",
        });
        return;
      }
      toast({
        title: "Backup started",
        description: "Writing to the scheduled folder. This card will update when it finishes.",
      });
    } catch {
      setScheduledRunning(false);
      toast({
        title: "Couldn't start the backup",
        description: "The app couldn't reach its own server. Try restarting.",
        variant: "destructive",
      });
    }
  }

  async function onRestore(mode: "wipe" | "merge") {
    if (!restoreFile) return;
    setRestoreRunning(true);
    // v1.0.11.2: restore is the longest known-busy op (multipart
    // upload + DB swap + ingest); the reconnect banner must stay
    // silent for the whole duration.
    setBusy(true);
    try {
      const form = new FormData();
      form.append("file", restoreFile);
      form.append("mode", mode);
      const r = await fetch("/api/backup/import", { method: "POST", body: form });
      const j = await r.json();
      if (!j?.ok) {
        toast({
          title: j?.detail?.title || "Restore couldn't finish",
          description: j?.detail?.next_action || j?.detail?.cause || j?.error || "Try again.",
          variant: "destructive",
        });
        // v1.0.11.3: refresh the last-op strip immediately on a JSON
        // error, not only on a network throw. The server has already
        // written the failed-restore record; without this call the
        // panel only picked it up on a manual page reload.
        void loadLastOps();
        return;
      }
      // v1.2.3: replace the fire-and-forget toast with an explicit
      // modal that spells out what a wipe restore actually did to the
      // Recovery panel, and where the pre-restore snapshot lives.
      // The modal is the primary surface; the toast stays as a short
      // confirmation so the change is not hidden behind a modal for
      // users who dismiss it immediately.
      if (mode === "wipe") {
        toast({
          title: "Restore complete",
          description: "AdvisePoint Docs needs to restart to finish loading the restored library.",
        });
        setPostRestoreInfo({
          mode: "wipe",
          source: restoreFile.name,
          documents: typeof j?.verified?.documents === "number" ? j.verified.documents : null,
          chunks: typeof j?.verified?.chunks === "number" ? j.verified.chunks : null,
          bak_dir: typeof j?.bak_dir === "string" ? j.bak_dir : null,
        });
        setPostRestoreOpen(true);
      } else {
        const docs = (j.documents_imported ?? j.documents_added ?? 0) as number;
        const chunks = (j.chunks_imported ?? j.chunks_added ?? 0) as number;
        toast({
          title: "Restore complete",
          description: `Merged ${docs} document(s) and ${chunks} chunk(s).`,
        });
        setPostRestoreInfo({
          mode: "merge",
          source: restoreFile.name,
          documents: docs,
          chunks: chunks,
          bak_dir: typeof j?.snapshot === "string" ? j.snapshot : null,
        });
        setPostRestoreOpen(true);
      }
      setRestoreFile(null);
      if (restoreInputRef.current) restoreInputRef.current.value = "";
      // v1.0.11.4: keep the reconnect banner silenced across the
      // post-response refetches. The server response returns as soon
      // as importMerge finishes the DB transaction and file copies,
      // but the client immediately fires several follow-ups
      // (loadSize, loadLastOps, and React-Query invalidations) that
      // can briefly stall the loop and produce a flash of the
      // reconnecting banner. Awaiting them here keeps setBusy(true)
      // for the whole window, then the finally block releases it.
      await Promise.allSettled([loadSize(), loadLastOps()]);
      // v1.0.14: refresh Library/Recovery/stats so a restore reflects
      // in the sidebar counter and Library list without a page reload.
      invalidateLibraryCaches();
    } catch (err) {
      // Fetch itself failed (network dropped mid-restore, etc.). The
      // server may still finish; refresh lastop when the poll cycle
      // recovers so the strip catches up.
      toast({
        title: "Restore didn't return a result",
        description: "The connection dropped during restore. Check the status strip once the panel reconnects.",
        variant: "destructive",
      });
      void loadLastOps();
    } finally {
      setBusy(false);
      setRestoreRunning(false);
    }
  }

  // -------- Derived flags --------

  const quickReady = quickPreflight?.ready === true
    || (quickPreflight?.ready === false && quickPreflight?.cloud_provider != null && quickCloudAck
        && quickPreflight?.present && quickPreflight?.writable && !quickPreflight?.low_space);

  const scheduledReady = scheduledPreflight?.ready === true
    || (scheduledPreflight?.ready === false && scheduledPreflight?.cloud_provider != null && scheduledCloudAck
        && scheduledPreflight?.present && scheduledPreflight?.writable && !scheduledPreflight?.low_space);

  const lastFailure = settings?.last_run_status === "failed" ? settings.last_run_error_detail : null;

  // v1.0.11.2: small helper that renders the persistent last-op strip
  // used on the Quick backup and Restore cards. Matches the visual
  // weight of the scheduled-backup card's Last run line.
  function LastOpStrip(props: {
    label: string;
    at: string | null;
    status: "success" | "failed" | null;
    detail: string | null;
    error: string | null;
  }) {
    if (!props.at && !props.status) {
      return (
        <div className="text-xs text-muted-foreground border-t pt-2">
          {props.label}: no runs yet on this machine.
        </div>
      );
    }
    const ok = props.status === "success";
    const Icon = ok ? CheckCircle2 : XCircle;
    const tone = ok ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400";
    return (
      <div className="text-xs text-muted-foreground border-t pt-2 space-y-0.5">
        <div className="flex items-center gap-1.5">
          <Icon className={`h-3.5 w-3.5 ${tone}`} />
          <span>
            {props.label}: {formatTimestamp(props.at)} · <span className={tone}>{ok ? "success" : "failed"}</span>
          </span>
        </div>
        {ok && props.detail && (
          <div className="pl-5 break-all" title={props.detail}>{props.detail}</div>
        )}
        {!ok && props.error && (
          <div className="pl-5 opacity-80">{props.error}</div>
        )}
      </div>
    );
  }

  // -------- Render helpers --------

  function PreflightStrip({
    result,
    loading,
    onAckCloud,
    cloudAck,
  }: {
    result: PreflightResult | null;
    loading: boolean;
    onAckCloud: (v: boolean) => void;
    cloudAck: boolean;
  }) {
    if (loading) {
      return (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span>Checking that folder…</span>
        </div>
      );
    }
    if (!result) {
      return (
        <div className="text-sm text-muted-foreground">
          Pick a folder to check it.
        </div>
      );
    }
    if (result.ready) {
      const free = formatBytes(result.free_bytes);
      const needed = formatBytes(result.needed_bytes);
      return (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 text-sm text-green-700 dark:text-green-400">
            <CheckCircle2 className="h-4 w-4" />
            <span>Ready — {free} free, ~{needed} needed</span>
          </div>
          {result.inside_data_dir && (
            <div className="text-xs text-amber-600 dark:text-amber-500" data-testid="preflight-inside-data-dir">
              This folder is inside the app's own data folder, next to the live database and page images.
              A backup kept there is lost along with the data it protects. Choose a folder on a different
              drive, or an external or network location.
            </div>
          )}
          {result.cloud_provider && (
            <CloudNotice provider={result.cloud_provider} ack={cloudAck} onAck={onAckCloud} required={false} />
          )}
        </div>
      );
    }
    if (result.low_space) {
      return (
        <div className="flex items-start gap-2 text-sm text-amber-700 dark:text-amber-400">
          <AlertTriangle className="h-4 w-4 mt-0.5" />
          <div>
            <div className="font-medium">{result.detail?.title ?? "Not enough free space"}</div>
            <div className="text-xs opacity-80">{result.detail?.next_action}</div>
          </div>
        </div>
      );
    }
    if (!result.present || !result.writable) {
      return (
        <div className="flex items-start gap-2 text-sm text-destructive">
          <XCircle className="h-4 w-4 mt-0.5" />
          <div>
            <div className="font-medium">{result.detail?.title ?? "Folder isn't ready"}</div>
            <div className="text-xs opacity-80">{result.detail?.next_action}</div>
          </div>
        </div>
      );
    }
    return null;
  }

  function CloudNotice({ provider, ack, onAck, required }: {
    provider: NonNullable<PreflightResult["cloud_provider"]>;
    ack: boolean;
    onAck: (v: boolean) => void;
    required: boolean;
  }) {
    const label = ({
      onedrive: "OneDrive",
      dropbox: "Dropbox",
      "google-drive": "Google Drive",
      icloud: "iCloud Drive",
      box: "Box",
    } as const)[provider];
    return (
      <div className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400">
        <AlertTriangle className="h-3.5 w-3.5 mt-0.5" />
        <label className="flex items-start gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={ack}
            onChange={(e) => onAck(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            This folder is inside {label}. Backups can be corrupted if the folder syncs mid-write.
            {required ? " Check this box to continue anyway." : ""}
          </span>
        </label>
      </div>
    );
  }

  // -------- Layout --------

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <HardDrive className="h-5 w-5 text-muted-foreground" />
        <h2 className="text-lg font-semibold">Backup &amp; Restore</h2>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4" data-testid="backup-columns">
        {/* --------- Column 1: Quick backup --------- */}
        <Card data-testid="backup-quick">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Download className="h-4 w-4" />
              Quick backup
            </CardTitle>
            <CardDescription>
              Save a one-off backup to a folder you pick. The file downloads through your browser.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="quick-folder">Save to folder</Label>
              <div className="flex gap-2">
                <Input
                  id="quick-folder"
                  value={quickFolder}
                  placeholder="e.g. D:\Backups"
                  onChange={(e) => { setQuickFolder(e.target.value); setQuickCloudAck(false); }}
                  onBlur={() => void runPreflight(quickFolder, setQuickPreflight, setQuickPreflightLoading)}
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void openBrowseFolder("quick", quickFolder, (p) => {
                    setQuickFolder(p);
                    setQuickCloudAck(false);
                    void runPreflight(p, setQuickPreflight, setQuickPreflightLoading);
                  })}
                  aria-label="Browse for folder"
                >
                  <FolderOpen className="h-4 w-4" />
                </Button>
              </div>
              <PreflightStrip
                result={quickPreflight}
                loading={quickPreflightLoading}
                onAckCloud={setQuickCloudAck}
                cloudAck={quickCloudAck}
              />
            </div>
            <div className="pt-1 space-y-2">
              <Button
                className="w-full"
                disabled={quickInFlight || !quickReady}
                onClick={() => void onQuickBackup()}
                data-testid="quick-backup-now"
              >
                {quickInFlight ? (
                  <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Backing up…</>
                ) : (
                  <><Save className="h-4 w-4 mr-2" /> Backup Now</>
                )}
              </Button>
              {/* v1.0.11.1: separate action for a browser download that
                  does NOT touch the chosen folder. Kept secondary so
                  the primary Back up now writes to the folder the
                  user picked. */}
              <Button
                type="button"
                variant="outline"
                className="w-full"
                disabled={downloadInFlight || quickInFlight}
                onClick={() => void onDownloadCopy()}
                data-testid="quick-download-copy"
              >
                {downloadInFlight ? (
                  <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Preparing…</>
                ) : (
                  <>Download a copy</>
                )}
              </Button>
              <p className="text-[11px] text-muted-foreground leading-snug">
                Backup Now writes to the folder above. Download a copy sends a ZIP through the browser to its default download location.
              </p>
            </div>
            <LastOpStrip
              label="Last backup"
              at={lastQuickBackup?.at ?? null}
              status={lastQuickBackup?.status ?? null}
              detail={lastQuickBackup?.path
                ? `${lastQuickBackup.path}${typeof lastQuickBackup.bytes === "number" ? ` (${formatBytes(lastQuickBackup.bytes)})` : ""}`
                : null}
              error={lastQuickBackup?.error ?? null}
            />
          </CardContent>
        </Card>

        {/* --------- Column 2: Scheduled backups --------- */}
        <Card data-testid="backup-scheduled">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Clock className="h-4 w-4" />
              Scheduled backups
            </CardTitle>
            <CardDescription>
              Let AdvisePoint Docs make backups on a schedule and keep the last few.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {lastFailure && (
              <div className="rounded border border-amber-300 bg-amber-50 dark:bg-amber-950/30 p-2 text-xs text-amber-800 dark:text-amber-300 flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <div className="flex-1">
                  <div className="font-medium">{lastFailure.title ?? "Last scheduled backup failed"}</div>
                  {lastFailure.cause && <div className="opacity-80">{lastFailure.cause}</div>}
                  {lastFailure.next_action && <div className="opacity-80 mt-0.5">{lastFailure.next_action}</div>}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-xs"
                  onClick={() => void onRunScheduledNow()}
                  disabled={scheduledRunning}
                >
                  <RefreshCw className="h-3 w-3 mr-1" /> Try again
                </Button>
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="scheduled-folder">Save to folder</Label>
              <div className="flex gap-2">
                <Input
                  id="scheduled-folder"
                  value={scheduledFolder}
                  placeholder="e.g. D:\Backups"
                  onChange={(e) => {
                    setScheduledFolder(e.target.value);
                    setScheduledDirty(true);
                    setScheduledCloudAck(false);
                  }}
                  onBlur={() => void runPreflight(scheduledFolder, setScheduledPreflight, setScheduledPreflightLoading)}
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void openBrowseFolder("scheduled", scheduledFolder, (p) => {
                    setScheduledFolder(p);
                    setScheduledDirty(true);
                    setScheduledCloudAck(false);
                    void runPreflight(p, setScheduledPreflight, setScheduledPreflightLoading);
                  })}
                  aria-label="Browse for folder"
                >
                  <FolderOpen className="h-4 w-4" />
                </Button>
              </div>
              <PreflightStrip
                result={scheduledPreflight}
                loading={scheduledPreflightLoading}
                onAckCloud={setScheduledCloudAck}
                cloudAck={scheduledCloudAck}
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label>Cadence</Label>
                <Select value={scheduledCadence} onValueChange={(v) => { setScheduledCadence(v as Cadence); setScheduledDirty(true); }}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="off">Off</SelectItem>
                    <SelectItem value="daily">Daily</SelectItem>
                    <SelectItem value="weekly">Weekly</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Run at</Label>
                <Input
                  type="time"
                  value={scheduledTime}
                  onChange={(e) => { setScheduledTime(e.target.value); setScheduledDirty(true); }}
                />
              </div>
              {scheduledCadence === "weekly" && (
                <div className="space-y-1.5">
                  <Label>Weekday</Label>
                  <Select value={String(scheduledWeekday)} onValueChange={(v) => { setScheduledWeekday(Number(v) as Weekday); setScheduledDirty(true); }}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"].map((d, i) => (
                        <SelectItem key={d} value={String(i)}>{d}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div className="space-y-1.5">
                <Label>Keep last</Label>
                <Input
                  type="number"
                  min={1}
                  max={365}
                  value={scheduledRetention}
                  onChange={(e) => { setScheduledRetention(parseInt(e.target.value, 10) || 1); setScheduledDirty(true); }}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 pt-1">
              <Button
                variant={scheduledDirty ? "default" : "outline"}
                disabled={!scheduledDirty || scheduledSaving}
                onClick={() => void onSaveSchedule()}
                data-testid="schedule-save"
              >
                {scheduledSaving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
                Save schedule
              </Button>
              <Button
                variant="outline"
                disabled={scheduledRunning || settingsLoading}
                onClick={() => void onRunScheduledNow()}
                data-testid="schedule-run-now"
              >
                {scheduledRunning ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
                Backup Now
              </Button>
            </div>
            <div className="text-xs text-muted-foreground border-t pt-2 space-y-0.5">
              <div>
                Next backup: ~{formatBytes(sizeEstimate)}
                {sizeBytes != null && sizeEstimate != null && (
                  <> · library on disk {formatBytes(sizeBytes)}</>
                )}
              </div>
              <div>
                Last run: {formatTimestamp(settings?.last_run_finished_at ?? null)}
                {settings?.last_run_status === "success" && settings.lastBytes != null && (
                  <> · {formatBytes(settings.lastBytes)} · success</>
                )}
                {settings?.last_run_status === "failed" && (
                  <> · failed</>
                )}
              </div>
              {settings?.next_run_at && scheduledCadence !== "off" && (
                <div>Next run: {formatTimestamp(settings.next_run_at)}</div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* --------- Column 3: Restore --------- */}
        <Card data-testid="backup-restore">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <UploadIcon className="h-4 w-4" />
              Restore from backup
            </CardTitle>
            <CardDescription>
              Load a backup file. Choose how it should merge with what you already have.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="restore-file">Backup file</Label>
              <input
                id="restore-file"
                ref={restoreInputRef}
                type="file"
                accept=".zip,application/zip"
                onChange={(e) => setRestoreFile(e.target.files?.[0] ?? null)}
                className="block w-full text-sm text-muted-foreground file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-primary file:text-primary-foreground hover:file:bg-primary/90"
              />
              {restoreFile && (
                <div className="text-xs text-muted-foreground truncate">
                  {restoreFile.name} ({formatBytes(restoreFile.size)})
                </div>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>How to restore</Label>
              <div className="space-y-2 text-sm">
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="restore-mode"
                    value="merge"
                    checked={restoreMode === "merge"}
                    onChange={() => setRestoreMode("merge")}
                    className="mt-1"
                  />
                  <span>
                    <span className="font-medium">Merge</span>
                    <span className="block text-xs text-muted-foreground">
                      Keep everything you have now. Add documents from the backup that aren't already there. Duplicates are skipped.
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="restore-mode"
                    value="wipe"
                    checked={restoreMode === "wipe"}
                    onChange={() => setRestoreMode("wipe")}
                    className="mt-1"
                  />
                  <span>
                    <span className="font-medium">Wipe &amp; Replace</span>
                    <span className="block text-xs text-muted-foreground">
                      Remove the current library and restore exactly what's in the backup. Your current library is set aside as a timestamped folder so you can roll back.
                    </span>
                  </span>
                </label>
              </div>
            </div>
            <div className="pt-1">
              <Button
                className="w-full"
                disabled={!restoreFile || restoreRunning}
                onClick={() => {
                  if (restoreMode === "wipe") setWipeConfirmOpen(true);
                  else void onRestore("merge");
                }}
                data-testid="restore-now"
              >
                {restoreRunning ? (
                  <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Restoring…</>
                ) : (
                  <><UploadIcon className="h-4 w-4 mr-2" /> Restore now</>
                )}
              </Button>
            </div>
            <LastOpStrip
              label="Last restore"
              at={lastRestore?.at ?? null}
              status={lastRestore?.status ?? null}
              detail={lastRestore?.source ?? null}
              error={lastRestore?.error ?? null}
            />
          </CardContent>
        </Card>
      </div>

      {/* --------- Folder picker (in-app path builder) --------- */}
      <AlertDialog open={pickerOpen != null} onOpenChange={(o) => { if (!o) setPickerOpen(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Choose a folder</AlertDialogTitle>
            <AlertDialogDescription>
              Pick a mounted drive, then type or paste the folder path.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-3">
            <div>
              <div className="flex items-center justify-between">
                <Label className="text-xs uppercase tracking-wide text-muted-foreground">Drives</Label>
                {/* v1.0.11.1: manual Refresh so the tester can pick up
                    an external drive attached after the panel opened,
                    without waiting for a tab-focus or visibility
                    lifecycle event. */}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => void loadDrives()}
                  disabled={drivesLoading}
                  aria-label="Refresh drives"
                >
                  {drivesLoading ? (
                    <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5 mr-1" />
                  )}
                  Refresh
                </Button>
              </div>
              {drives.length === 0 ? (
                <div className="text-sm text-muted-foreground py-2">
                  {drivesLoading
                    ? "Looking for drives…"
                    : "No drives detected (or not running on Windows). Type a full folder path below."}
                </div>
              ) : (
                <div className="flex flex-wrap gap-2 pt-1">
                  {drives.map((d) => (
                    <Button
                      key={d.letter}
                      variant="outline"
                      size="sm"
                      onClick={() => setPickerPath(d.root)}
                      className="gap-1"
                    >
                      <HardDrive className="h-3.5 w-3.5" />
                      {d.letter}:\
                    </Button>
                  ))}
                </div>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="picker-path">Folder path</Label>
              <Input
                id="picker-path"
                value={pickerPath}
                onChange={(e) => setPickerPath(e.target.value)}
                placeholder="e.g. D:\Backups\AdvisePoint Docs"
              />
            </div>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pickerOpen === "quick") {
                  setQuickFolder(pickerPath);
                  setQuickCloudAck(false);
                  void runPreflight(pickerPath, setQuickPreflight, setQuickPreflightLoading);
                } else if (pickerOpen === "scheduled") {
                  setScheduledFolder(pickerPath);
                  setScheduledDirty(true);
                  setScheduledCloudAck(false);
                  void runPreflight(pickerPath, setScheduledPreflight, setScheduledPreflightLoading);
                }
                setPickerOpen(null);
              }}
            >
              Use this folder
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* --------- Wipe restore confirmation --------- */}
      <AlertDialog open={wipeConfirmOpen} onOpenChange={setWipeConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <ShieldAlert className="h-5 w-5 text-destructive" /> Replace the whole library?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Wipe &amp; Replace removes your current library before loading the backup. Your current library is set aside as a timestamped folder next to the app's data directory so you can roll back. AdvisePoint Docs will need to restart when the restore finishes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { setWipeConfirmOpen(false); void onRestore("wipe"); }}
            >
              Replace and restart
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* --------- v1.2.3: post-restore guidance modal --------- */}
      {/* This fires as soon as a restore finishes and explains, in
          this order:
            1. What the restore actually did to the library.
            2. Where the pre-restore snapshot lives (wipe mode only),
               so the user can recover to pre-restore state.
            3. How Recovery's Delete-All interacts with this restore
               -- specifically that Delete-All operates on the library
               that exists AFTER the restore, so it removes what the
               restore just added, not the pre-restore state.
          The same information is written to the side-file so a first-
          launch banner surfaces it on the next boot if the modal is
          dismissed or the app is force-closed before the user sees it. */}
      <AlertDialog
        open={postRestoreOpen}
        onOpenChange={(next) => {
          setPostRestoreOpen(next);
          if (!next) {
            // Dismissing the modal clears the side-file so the same
            // restore does not trigger the first-launch banner on the
            // next boot. Fire-and-forget: a failure just means the
            // banner may appear once, which is not incorrect.
            void fetch("/api/backup/restore-banner/dismiss", { method: "POST" }).catch(() => {});
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {postRestoreInfo?.mode === "wipe"
                ? "Restore complete \u2014 restart required"
                : "Restore complete"}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-sm">
                {postRestoreInfo?.mode === "wipe" ? (
                  <p>
                    Your library has been replaced from{" "}
                    <span className="font-medium">
                      {postRestoreInfo?.source ?? "the selected backup"}
                    </span>
                    {typeof postRestoreInfo?.documents === "number" ? (
                      <> ({postRestoreInfo.documents} document{postRestoreInfo.documents === 1 ? "" : "s"}
                      {typeof postRestoreInfo?.chunks === "number" ? `, ${postRestoreInfo.chunks} chunk${postRestoreInfo.chunks === 1 ? "" : "s"}` : ""})</>
                    ) : null}
                    . Restart AdvisePoint Docs to finish loading it.
                  </p>
                ) : (
                  <p>
                    Merged{" "}
                    <span className="font-medium">{postRestoreInfo?.documents ?? 0}</span> document(s) and{" "}
                    <span className="font-medium">{postRestoreInfo?.chunks ?? 0}</span> chunk(s) from{" "}
                    <span className="font-medium">{postRestoreInfo?.source ?? "the selected backup"}</span>{" "}
                    into the existing library.
                  </p>
                )}
                {postRestoreInfo?.bak_dir ? (
                  <div className="rounded-md border bg-muted/40 p-2">
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      Pre-restore snapshot
                    </div>
                    <code className="break-all text-xs">{postRestoreInfo.bak_dir}</code>
                    <p className="mt-1 text-xs text-muted-foreground">
                      This folder is not deleted automatically. To roll back to what was here before the restore, close AdvisePoint Docs, rename this folder over the current data folder, and restart.
                    </p>
                  </div>
                ) : null}
                <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
                  <div className="text-[10px] uppercase tracking-wider">Heads up about Recovery &rarr; Delete all</div>
                  <p className="mt-1 text-xs">
                    Recovery works on the library that exists <em>now</em> (after this restore). If you use Delete all in Recovery, it removes what this restore just added. It does not undo the restore or return you to the pre-restore state. Use the snapshot above for that.
                  </p>
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction data-testid="button-post-restore-ack">Got it</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </div>
  );
}

export default BackupPanel;
