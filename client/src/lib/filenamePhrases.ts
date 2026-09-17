// v1.2.4 -- Client-side hook + typed accessor for the Filename PHRASES ->
// Document type mapping (item 2). Companion to filenameCodes.ts.
//
// Mirrors filenameCodes.ts line-by-line so future maintainers can diff-read
// the two. Same React Query cache pattern, same 30s staleTime, same
// mutation-writes-cache trick. The only real differences are the endpoint
// path and the FilenamePhraseMapping row shape (phrase vs code).

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type { FilenamePhraseMapping } from "@/lib/detect-doctype";

export interface FilenamePhraseSettings {
  mappings: FilenamePhraseMapping[];
  /** Every currently-registered document_types.key. Used by the editor to
   *  flag orphaned mapping rows whose underlying type was deleted. */
  known_doc_type_keys: string[];
}

/** Read-only hook for classification code paths -- upload page, Detect
 *  button. Returns undefined until the first fetch resolves. */
export function useFilenamePhrases() {
  return useQuery<FilenamePhraseSettings>({
    queryKey: ["/api/settings/filename-phrases"],
    // Keep this fresh for a while -- the mapping rarely changes and paying
    // the round-trip on every mount would be pointless.
    staleTime: 30_000,
  });
}

/** Mutation hook used by the editor to overwrite the whole mapping. */
export function useSaveFilenamePhrases() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (mappings: FilenamePhraseMapping[]) => {
      const res = await apiRequest("PUT", "/api/settings/filename-phrases", { mappings });
      return (await res.json()) as FilenamePhraseSettings;
    },
    onSuccess: (next) => {
      qc.setQueryData(["/api/settings/filename-phrases"], next);
    },
  });
}
