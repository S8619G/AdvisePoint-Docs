// v1.1.0 -- Client-side hook + typed accessor for the Filename codes ->
// Document type mapping (item 9). Companion to `detect-doctype.ts` (pure
// classifier) and the FilenameCodesEditor in Settings > Document types.
//
// The mapping lives server-side under `/api/settings/filename-codes` and is
// cached by React Query, mirroring the useDocumentTypes() pattern. Every
// place that classifies (upload page auto-fill, per-file Detect button) reads
// this hook, so a change made in Settings takes effect on the next render
// once React Query refetches.

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type { FilenameCodeMapping } from "@/lib/detect-doctype";

export interface FilenameCodeSettings {
  mappings: FilenameCodeMapping[];
  /** Every currently-registered document_types.key. Used by the editor to
   *  flag orphaned mapping rows whose underlying type was deleted. */
  known_doc_type_keys: string[];
}

/** Read-only hook for classification code paths -- upload page, Detect
 *  button. Returns undefined until the first fetch resolves. */
export function useFilenameCodes() {
  return useQuery<FilenameCodeSettings>({
    queryKey: ["/api/settings/filename-codes"],
    // Keep this fresh for a while -- the mapping rarely changes and paying
    // the round-trip on every mount would be pointless.
    staleTime: 30_000,
  });
}

/** Mutation hook used by the editor to overwrite the whole mapping. */
export function useSaveFilenameCodes() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (mappings: FilenameCodeMapping[]) => {
      const res = await apiRequest("PUT", "/api/settings/filename-codes", { mappings });
      return (await res.json()) as FilenameCodeSettings;
    },
    onSuccess: (next) => {
      qc.setQueryData(["/api/settings/filename-codes"], next);
    },
  });
}
