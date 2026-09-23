import {useQuery} from "@tanstack/react-query";
export function LibraryStoragePanel() {
  const {data,isError}=useQuery<any>({queryKey:["/api/backup/size"],refetchInterval:15000});
  const mb=(n=0)=>(n/1048576).toFixed(2)+" MiB";
  return <section className="rounded-lg border p-5 space-y-3">
    <h2 className="font-semibold">Library storage</h2>
    {data?.ok ? <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm" data-testid="storage-breakdown">
      <div><dt>Retained original files</dt><dd>{mb(data.original_bytes)}</dd></div>
      <div><dt>SQLite database</dt><dd>{mb(data.db_bytes)}</dd></div>
      <div><dt>SQLite working files (WAL + SHM)</dt><dd>{mb(data.wal_bytes+data.shm_bytes)}</dd></div>
      <div><dt>Stored page images</dt><dd>{mb(data.pages_bytes)}</dd></div>
      <div className="sm:col-span-2 border-t pt-2 font-semibold"><dt>Total active library on disk</dt>
        <dd>{mb(data.current_backup_size_bytes)}</dd></div>
    </dl> : <p className="text-sm">{isError?"Storage information could not be loaded.":"Calculating library storage…"}</p>}
    <p className="text-xs text-muted-foreground">The total includes all four items above, not just the database.
      Temporary external-reader copies, logs and backups are excluded. New PDFs use an in-memory page cache;
      existing page images are kept. Working-file sizes change while the app is running.</p>
  </section>;
}
