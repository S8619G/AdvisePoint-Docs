// v1.2.4 (item 2) -- User override surface for the filename-PHRASE ->
// Document type mapping. Sits BELOW FilenameCodesEditor in Settings >
// Document types, separated by a divider (see schema.tsx). Follows the
// existing settings visual style (Card + editable table).
//
// Mirrors FilenameCodesEditor.tsx line-by-line so future maintainers can
// diff-read the two -- the differences are all deliberate and small:
//   * Phrase column is a wider free-text input (2-64 chars, letters allowed
//     anywhere, punctuation permitted -- not restricted to A-Z0-9 like a code).
//   * Validation uses NORMALIZED form for duplicate checks: "User Guide" and
//     "user guide" collide, matching how the detector treats them. That
//     mirrors the server's normalizePhrase() rule (lowercase, `._-` -> space,
//     collapse whitespace, trim).
//   * Codes run FIRST at classification time; phrases are the fallback --
//     this is enforced in detectDocType(), not here. The card copy calls it
//     out so the user's mental model matches the runtime behavior.
//   * Length: 2-64 chars normalized. Must contain at least one letter (so
//     "-" or "123" alone are rejected). No leading/trailing whitespace.
//
// Behavior locked with the user:
//   * Two columns: Phrase (free text) and Document type (dropdown).
//   * Change / delete / add rows. Save is deferred to an explicit "Save
//     changes" click.
//   * Orphaned rows show the same red "Type deleted" pill as the codes editor.
//   * Duplicates and invalid phrases are rejected before the PUT.

import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2, AlertCircle } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useDocumentTypes } from "@/lib/documentTypes";
import { useFilenamePhrases, useSaveFilenamePhrases } from "@/lib/filenamePhrases";
import { normalizeForPhraseMatch } from "@/lib/detect-doctype";
import type { FilenamePhraseMapping } from "@/lib/detect-doctype";

// Sentinel value used inside the dropdown when the current key is orphaned
// (its underlying Document type was deleted). Radix Select forbids "" as an
// item value, so we use a distinct marker and translate it back to "" on
// commit. Nothing else in the app should ever store this string.
const ORPHAN_SENTINEL = "__filename_phrase_orphan__";

const PHRASE_MIN = 2;
const PHRASE_MAX = 64;

type DraftRow = FilenamePhraseMapping & {
  /** Stable client-only id so React keys survive edits and delete-inserts. */
  _rid: number;
};

let ridCounter = 1;
function newRid() {
  return ridCounter++;
}

/** Match the SERVER's validation rules so a save round-trip either succeeds
 *  or the client rejects it locally without an error toast from the API. */
function validatePhraseText(phrase: string): string | null {
  if (phrase !== phrase.trim()) return "Phrase cannot start or end with whitespace.";
  const normalized = normalizeForPhraseMatch(phrase, false);
  if (normalized.length < PHRASE_MIN) {
    return `Phrase must be at least ${PHRASE_MIN} characters after normalization.`;
  }
  if (normalized.length > PHRASE_MAX) {
    return `Phrase must be at most ${PHRASE_MAX} characters after normalization.`;
  }
  if (!/[a-z]/.test(normalized)) {
    return "Phrase must contain at least one letter.";
  }
  return null;
}

export function FilenamePhrasesEditor() {
  const { data: docTypes } = useDocumentTypes();
  const { data: phrases, isLoading } = useFilenamePhrases();
  const saveMutation = useSaveFilenamePhrases();
  const { toast } = useToast();

  // Local draft state -- lets the user tweak several rows before committing.
  const [draft, setDraft] = useState<DraftRow[]>([]);

  // Re-seed the draft when the server data first arrives OR when someone else
  // changes the mapping. We deliberately do NOT overwrite an unsaved draft.
  useEffect(() => {
    if (!phrases) return;
    if (draft.length === 0) {
      setDraft(phrases.mappings.map((m) => ({ ...m, _rid: newRid() })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phrases]);

  const knownKeys = useMemo(
    () => new Set((docTypes?.types ?? []).map((t) => t.key)),
    [docTypes],
  );

  const setRow = (rid: number, patch: Partial<FilenamePhraseMapping>) => {
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
      { _rid: newRid(), phrase: "", doc_type_key: "" },
    ]);
  };

  const isDirty = useMemo(() => {
    if (!phrases) return false;
    if (phrases.mappings.length !== draft.length) return true;
    for (let i = 0; i < draft.length; i++) {
      const a = draft[i];
      const b = phrases.mappings[i];
      if (!b) return true;
      if (a.phrase !== b.phrase || a.doc_type_key !== b.doc_type_key) return true;
    }
    return false;
  }, [draft, phrases]);

  const handleSave = () => {
    // Validate: reject empty/invalid phrases, reject duplicates on normalized form.
    const cleaned: FilenamePhraseMapping[] = [];
    const seenNormalized = new Set<string>();
    for (const row of draft) {
      const phrase = row.phrase;
      const err = validatePhraseText(phrase);
      if (err) {
        toast({
          title: "Invalid phrase",
          description: `"${phrase || "(blank)"}": ${err}`,
          variant: "destructive",
        });
        return;
      }
      const key = normalizeForPhraseMatch(phrase, false);
      if (seenNormalized.has(key)) {
        toast({
          title: "Duplicate phrase",
          description: `The phrase "${phrase}" is used more than once (matched on normalized form).`,
          variant: "destructive",
        });
        return;
      }
      seenNormalized.add(key);
      // doc_type_key may legitimately be "" for a deliberately-orphaned row --
      // the classifier just skips such rows.
      cleaned.push({ phrase, doc_type_key: row.doc_type_key });
    }

    saveMutation.mutate(cleaned, {
      onSuccess: (next) => {
        setDraft(next.mappings.map((m) => ({ ...m, _rid: newRid() })));
        toast({ title: "Filename phrases saved" });
      },
      onError: (err: any) => {
        toast({
          title: "Could not save filename phrases",
          description: err?.message ?? "Unknown error",
          variant: "destructive",
        });
      },
    });
  };

  const handleReset = () => {
    if (!phrases) return;
    setDraft(phrases.mappings.map((m) => ({ ...m, _rid: newRid() })));
  };

  return (
    <Card data-testid="card-filename-phrases">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Filename phrases</CardTitle>
        <CardDescription className="text-xs">
          Map full phrases in a filename to a Document type. Runs only after
          Filename codes above return nothing, so a code on the same file still
          wins. Matches whole-word inside the filename after normalizing case
          and punctuation. Longest matching phrase wins. Never overwrites a
          type you have already picked.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading && (
          <p className="text-xs text-muted-foreground">Loading&hellip;</p>
        )}
        {!isLoading && draft.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No filename phrases configured. Add a row to start auto-classifying uploads.
          </p>
        )}
        {draft.length > 0 && (
          <div className="space-y-2">
            <div className="grid grid-cols-[minmax(12rem,1.4fr)_minmax(10rem,1fr)_2.25rem] gap-2 px-1 text-xs uppercase tracking-wide text-muted-foreground">
              <div>Phrase</div>
              <div>Document type</div>
              <div />
            </div>
            {draft.map((row) => {
              const isOrphan =
                row.doc_type_key !== "" && !knownKeys.has(row.doc_type_key);
              const phraseError = row.phrase !== "" ? validatePhraseText(row.phrase) : null;
              const selectValue = isOrphan ? ORPHAN_SENTINEL : (row.doc_type_key || "");
              return (
                <div
                  key={row._rid}
                  className="grid grid-cols-[minmax(12rem,1.4fr)_minmax(10rem,1fr)_2.25rem] items-center gap-2"
                  data-testid={`row-filename-phrase-${row._rid}`}
                >
                  <Input
                    value={row.phrase}
                    onChange={(e) => setRow(row._rid, { phrase: e.target.value })}
                    placeholder="user guide"
                    maxLength={PHRASE_MAX}
                    aria-invalid={row.phrase !== "" && phraseError !== null}
                    className={
                      row.phrase !== "" && phraseError !== null
                        ? "border-destructive"
                        : ""
                    }
                    data-testid={`input-filename-phrase-${row._rid}`}
                  />
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="min-w-0 flex-1">
                      <Select
                        value={selectValue || undefined}
                        onValueChange={(v) => {
                          if (v === ORPHAN_SENTINEL) return;
                          setRow(row._rid, { doc_type_key: v });
                        }}
                      >
                        <SelectTrigger data-testid={`select-filename-phrase-doctype-${row._rid}`}>
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
                        data-testid={`pill-filename-phrase-orphan-${row._rid}`}
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
                    aria-label={`Delete phrase ${row.phrase || "(blank)"}`}
                    data-testid={`button-filename-phrase-delete-${row._rid}`}
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
            data-testid="button-filename-phrase-add"
          >
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Add phrase
          </Button>
          <div className="flex-1" />
          {isDirty && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleReset}
              disabled={saveMutation.isPending}
              data-testid="button-filename-phrase-reset"
            >
              Discard changes
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            onClick={handleSave}
            disabled={!isDirty || saveMutation.isPending}
            data-testid="button-filename-phrase-save"
          >
            {saveMutation.isPending ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
