import { useQuery } from "@tanstack/react-query";

export interface DocumentTypeOption {
  key: string;
  label: string;
  is_builtin: boolean;
  sort_order: number;
  document_count: number;
  // v0.9.36: optional accent color ("#rrggbb" lowercase) or null for no color.
  color: string | null;
}

// v0.9.36: helper to resolve a doc-type's color from the registry.
// Returns null when the type is unknown or the user hasn't set a color.
export function documentTypeColor(
  key: string,
  types: DocumentTypeOption[] | undefined,
): string | null {
  return types?.find((type) => type.key === key)?.color ?? null;
}

export interface DocumentTypeRegistry {
  sort_mode: "importance" | "alphabetical";
  types: DocumentTypeOption[];
}

export function useDocumentTypes() {
  return useQuery<DocumentTypeRegistry>({ queryKey: ["/api/document-types"] });
}

export function documentTypeLabel(
  key: string,
  types: DocumentTypeOption[] | undefined,
): string {
  return types?.find((type) => type.key === key)?.label ?? key.replace(/_/g, " ");
}
