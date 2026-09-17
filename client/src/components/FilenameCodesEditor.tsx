// v1.1.0 (item 9) -- User override surface for the filename-code ->
// Document type mapping. Sits BELOW DocumentTypeManager in Settings >
// Document types, separated by a divider (see schema.tsx). Follows the
// existing settings visual style (Card + editable table).
//
// Behavior locked with the user:
//   * Two columns: Code (uppercase, 1-8 chars A-Z0-9) and Document type
//     (dropdown of currently-configured types).
//   * Change / delete / add rows. Save is deferred to an explicit "Save
//     changes" click so the user can adjust several rows before committing
//     -- follows the same feel as the sort-mode radios in the manager above.
//   * A row whose doc_type_key no longer resolves to a known type shows a
//     red "Type deleted" pill and the dropdown surfaces "-- reassign --".
//     Selecting a replacement clears the orphan state.
//   * On save, duplicate codes and empty codes are rejected before the PUT
//     goes out.
//   * Adding a Document type from THIS editor is out of scope; the manager
//     above already handles that path -- we just consume the current list.

import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2, AlertCircle } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useDocumentTypes } from "@/lib/documentTypes";
import { useFilenameCodes, useSaveFilenameCodes } from "@/lib/filenameCodes";
import type { FilenameCodeMapping } from "@/lib/detect-doctype";

// Sentinel value used inside the dropdown when the current key is orphaned
// (its underlying Document type was deleted). Radix Select forbids "" as an
// item value, so we use a distinct marker and translate it back to "" on
// commit. Nothing else in the app should ever store this string.
const ORPHAN_SENTINEL = "__filename_code_orphan__";

type DraftRow = FilenameCodeMapping & {
  /** Stable client-only id so React keys survive edits and delete-inserts. */
  _rid: number;
};

let ridCounter = 1;
function newRid() {
  return ridCounter++;
}

function normalizeCode(input: string): string {
  return input.trim().toUpperCase().slice(0, 8);
}

function isValidCode(code: string): boolean {
  return code.length >= 1 && code.length <= 8 && /^[A-Z0-9]+$/.test(code);
}

export function FilenameCodesEditor() {
  const { data: docTypes } = useDocumentTypes();
  const { data: codes, isLoading } = useFilenameCodes();
  const saveMutation = useSaveFilenameCodes();
  const { toast } = useToast();

  // Local draft state -- lets the user tweak several rows before committing.
  const [draft, setDraft] = useState<DraftRow[]>([]);

  // Re-seed the draft when the server data first arrives OR when someone else
  // changes the mapping (e.g. a future admin flow). We deliberately do NOT
  // overwrite an unsaved draft; the mutation's onSuccess already updates the
  // cache and the next effect run will pick up the fresh values.
  useEffect(() => {
    if (!codes) return;
    if (draft.length === 0) {
      setDraft(codes.mappings.map((m) => ({ ...m, _rid: newRid() })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codes]);

  const knownKeys = useMemo(
    () => new Set((docTypes?.types ?? []).map((t) => t.key)),
    [docTypes],
  );

  const setRow = (rid: number, patch: Partial<FilenameCodeMapping>) => {
    setDraft((rows) =>
      rows.map((r) => (r._rid === rid ? { ...r, ...patch } : r)),
    );
  };

  const removeRow = (rid: number) => {
    setDraft((rows) => rows.filter((r) => r._rid !== rid));
  };

  const addRow = () => {
    setDraft((rows) => [
      ...rows,
      { _rid: newRid(), code: "", doc_type_key: "" },
    ]);
  };

  const isDirty = useMemo(() => {
    if (!codes) return false;
    if (codes.mappings.length !== draft.length) return true;
    for (let i = 0; i < draft.length; i++) {
      const a = draft[i];
      const b = codes.mappings[i];
      if (!b) return true;
      if (a.code !== b.code || a.doc_type_key !== b.doc_type_key) return true;
    }
    return false;
  }, [draft, codes]);

  const handleSave = () => {
    // Validate: normalize codes, reject empties, reject duplicates.
    const normalized: FilenameCodeMapping[] = [];
    const seen = new Set<string>();
    for (const row of draft) {
      const code = normalizeCode(row.code);
      if (!isValidCode(code)) {
        toast({
          title: "Invalid code",
          description: "Each code must be 1-8 characters, letters and digits only.",
          variant: "destructive",
        });
        return;
      }
      if (seen.has(code)) {
        toast({
          title: "Duplicate code",
          description: `The code "${code}" is used more than once.`,
          variant: "destructive",
        });
        return;
      }
      seen.add(code);
      // doc_type_key may legitimately be "" for a deliberately-orphaned row --
      // the classifier just skips such rows.
      normalized.push({ code, doc_type_key: row.doc_type_key });
    }

    saveMutation.mutate(normalized, {
      onSuccess: (next) => {
        // Rebuild the draft from the fresh server response so any
        // normalization the server did (e.g. code trimming) is reflected.
        setDraft(next.mappings.map((m) => ({ ...m, _rid: newRid() })));
        toast({ title: "Filename codes saved" });
      },
      onError: (err: any) => {
        toast({
          title: "Could not save filename codes",
          description: err?.message ?? "Unknown error",
          variant: "destructive",
        });
      },
    });
  };

  const handleReset = () => {
    if (!codes) return;
    setDraft(codes.mappings.map((m) => ({ ...m, _rid: newRid() })));
  };

  return (
    <Card data-testid="card-filename-codes">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Filename codes</CardTitle>
        <CardDescription className="text-xs">
          Map short codes in a filename to a Document type so uploads classify
          themselves. Detection uses the same tokenizer as Fix Title; the last
          matching code in a filename wins. Never overwrites a type you have
          already picked.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading && (
          <p className="text-xs text-muted-foreground">Loading&hellip;</p>
        )}
        {!isLoading && draft.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No filename codes configured. Add a row to start auto-classifying uploads.
          </p>
        )}
        {draft.length > 0 && (
          <div className="space-y-2">
            <div className="grid grid-cols-[7rem_1fr_2.25rem] gap-2 px-1 text-xs uppercase tracking-wide text-muted-foreground">
              <div>Code</div>
              <div>Document type</div>
              <div />
            </div>
            {draft.map((row) => {
              const isOrphan =
                row.doc_type_key !== "" && !knownKeys.has(row.doc_type_key);
              const codeLooksValid = isValidCode(normalizeCode(row.code));
              const selectValue = isOrphan ? ORPHAN_SENTINEL : (row.doc_type_key || "");
              return (
                <div
                  key={row._rid}
                  className="grid grid-cols-[7rem_1fr_2.25rem] items-center gap-2"
                  data-testid={`row-filename-code-${row._rid}`}
                >
                  <Input
                    value={row.code}
                    onChange={(e) =>
                      setRow(row._rid, { code: normalizeCode(e.target.value) })
                    }
                    placeholder="OG"
                    maxLength={8}
                    aria-invalid={row.code !== "" && !codeLooksValid}
                    className={
                      row.code !== "" && !codeLooksValid
                        ? "font-mono border-destructive"
                        : "font-mono"
                    }
                    data-testid={`input-filename-code-${row._rid}`}
                  />
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="min-w-0 flex-1">
                      <Select
                        value={selectValue || undefined}
                        onValueChange={(v) => {
                          // Selecting the orphan sentinel is a no-op -- it
                          // only exists so Radix can render the current state.
                          if (v === ORPHAN_SENTINEL) return;
                          setRow(row._rid, { doc_type_key: v });
                        }}
                      >
                        <SelectTrigger data-testid={`select-filename-code-doctype-${row._rid}`}>
                          <SelectValue placeholder="Select a Document type" />
                        </SelectTrigger>
                        <SelectContent>
                          {isOrphan && (
                            <SelectItem value={ORPHAN_SENTINEL} disabled>
                              -- reassign --
                            </SelectItem>
                          )}
                          {docTypes?.types.map((t) => (
                            <SelectItem key={t.key} value={t.key}>
                              {t.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    {isOrphan && (
                      <span
                        className="inline-flex items-center gap-1 rounded-full border border-destructive/50 bg-destructive/10 px-2 py-0.5 text-xs text-destructive"
                        data-testid={`pill-filename-code-orphan-${row._rid}`}
                      >
                        <AlertCircle className="h-3 w-3" />
                        Type deleted
                      </span>
                    )}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-destructive"
                    onClick={() => removeRow(row._rid)}
                    aria-label={`Delete code ${row.code || "(blank)"}`}
                    data-testid={`button-filename-code-delete-${row._rid}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              );
            })}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={addRow}
            data-testid="button-filename-code-add"
          >
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Add code
          </Button>
          <div className="flex-1" />
          {isDirty && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleReset}
              disabled={saveMutation.isPending}
              data-testid="button-filename-code-reset"
            >
              Discard changes
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            onClick={handleSave}
            disabled={!isDirty || saveMutation.isPending}
            data-testid="button-filename-code-save"
          >
            {saveMutation.isPending ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
