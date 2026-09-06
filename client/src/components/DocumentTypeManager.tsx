import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Pencil, Pipette, Plus, Trash2, X } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useDocumentTypes, type DocumentTypeOption, type DocumentTypeRegistry } from "@/lib/documentTypes";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DocumentTypeColorPicker } from "@/components/DocumentTypeColorPicker";

async function jsonRequest(method: string, url: string, body?: unknown) {
  const response = await apiRequest(method, url, body);
  return response.json();
}

export function DocumentTypeManager() {
  const { data, isLoading } = useDocumentTypes();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [newLabel, setNewLabel] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [deleting, setDeleting] = useState<DocumentTypeOption | null>(null);

  const updateRegistry = (registry: DocumentTypeRegistry) => {
    queryClient.setQueryData(["/api/document-types"], registry);
    queryClient.invalidateQueries({ queryKey: ["/api/documents"] });
    queryClient.invalidateQueries({ queryKey: ["/api/facets"] });
  };

  const createMutation = useMutation({
    mutationFn: (label: string) => jsonRequest("POST", "/api/document-types", { label }),
    onSuccess: (registry) => {
      updateRegistry(registry);
      setNewLabel("");
      toast({ title: "Document type added" });
    },
    onError: (error: Error) => toast({ title: "Could not add document type", description: error.message, variant: "destructive" }),
  });

  const renameMutation = useMutation({
    mutationFn: ({ key, label }: { key: string; label: string }) =>
      jsonRequest("PATCH", `/api/document-types/${encodeURIComponent(key)}`, { label }),
    onSuccess: (registry) => {
      updateRegistry(registry);
      setEditing(null);
      toast({ title: "Document type renamed" });
    },
    onError: (error: Error) => toast({ title: "Could not rename document type", description: error.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (key: string) => jsonRequest("DELETE", `/api/document-types/${encodeURIComponent(key)}`),
    onSuccess: (result) => {
      updateRegistry(result);
      setDeleting(null);
      toast({
        title: "Document type deleted",
        description: result.reassigned
          ? `${result.reassigned} document${result.reassigned === 1 ? "" : "s"} changed to Document.`
          : "No documents needed reassignment.",
      });
    },
    onError: (error: Error) => toast({ title: "Could not delete document type", description: error.message, variant: "destructive" }),
  });

  const orderMutation = useMutation({
    mutationFn: ({ mode, keys }: { mode: DocumentTypeRegistry["sort_mode"]; keys: string[] }) =>
      jsonRequest("PUT", "/api/document-types/order", { mode, keys }),
    onSuccess: updateRegistry,
    onError: (error: Error) => toast({ title: "Could not save document type order", description: error.message, variant: "destructive" }),
  });

  // v0.9.36: mutate a single type's accent color. Body of null clears it.
  const colorMutation = useMutation({
    mutationFn: ({ key, color }: { key: string; color: string | null }) =>
      jsonRequest("PATCH", `/api/document-types/${encodeURIComponent(key)}/color`, { color }),
    onSuccess: updateRegistry,
    onError: (error: Error) => toast({ title: "Could not update color", description: error.message, variant: "destructive" }),
  });

  const move = (index: number, delta: -1 | 1) => {
    if (!data) return;
    const types = [...data.types];
    const target = index + delta;
    if (target < 0 || target >= types.length) return;
    [types[index], types[target]] = [types[target], types[index]];
    updateRegistry({ ...data, types });
    orderMutation.mutate({ mode: "importance", keys: types.map((type) => type.key) });
  };

  if (isLoading || !data) {
    return <Card><CardContent className="py-8 text-sm text-muted-foreground">Loading document types…</CardContent></Card>;
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Document types</CardTitle>
          <CardDescription>
            Add, rename, delete, and prioritize the types shown throughout Upload, Library, and Query.
            Deleting a type changes its documents to Document.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <Label>Display order</Label>
            <RadioGroup
              value={data.sort_mode}
              onValueChange={(mode) => orderMutation.mutate({
                mode: mode as DocumentTypeRegistry["sort_mode"],
                keys: data.types.map((type) => type.key),
              })}
              className="flex flex-wrap gap-5"
              data-testid="document-type-sort-mode"
            >
              <div className="flex items-center gap-2">
                <RadioGroupItem value="importance" id="doctype-importance" />
                <Label htmlFor="doctype-importance" className="font-normal">Importance (custom)</Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="alphabetical" id="doctype-alphabetical" />
                <Label htmlFor="doctype-alphabetical" className="font-normal">Alphabetical</Label>
              </div>
            </RadioGroup>
          </div>

          <div className="flex gap-2">
            <Input
              value={newLabel}
              onChange={(event) => setNewLabel(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && newLabel.trim()) createMutation.mutate(newLabel.trim());
              }}
              placeholder="New document type"
              data-testid="input-new-document-type"
              maxLength={80}
            />
            <Button
              onClick={() => createMutation.mutate(newLabel.trim())}
              disabled={!newLabel.trim() || createMutation.isPending}
              data-testid="button-add-document-type"
            >
              <Plus className="mr-1.5 h-4 w-4" /> Add
            </Button>
          </div>

          <div className="divide-y rounded-md border">
            {data.types.map((type, index) => (
              <div key={type.key} className="flex min-h-14 items-center gap-2 px-3 py-2" data-testid={`document-type-row-${type.key}`}>
                {editing === type.key ? (
                  <Input
                    value={editLabel}
                    onChange={(event) => setEditLabel(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && editLabel.trim()) renameMutation.mutate({ key: type.key, label: editLabel.trim() });
                      if (event.key === "Escape") setEditing(null);
                    }}
                    className="h-8"
                    autoFocus
                    maxLength={80}
                    data-testid={`input-rename-${type.key}`}
                  />
                ) : (
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{type.label}</div>
                    <div className="text-xs text-muted-foreground">
                      {type.document_count} document{type.document_count === 1 ? "" : "s"}
                      {type.key === "document" ? " · protected fallback" : ""}
                    </div>
                  </div>
                )}

                {editing === type.key ? (
                  <>
                    <Button size="sm" onClick={() => renameMutation.mutate({ key: type.key, label: editLabel.trim() })} disabled={!editLabel.trim()}>Save</Button>
                    <Button size="icon" variant="ghost" onClick={() => setEditing(null)} aria-label="Cancel rename"><X className="h-4 w-4" /></Button>
                  </>
                ) : (
                  <>
                    {/* v0.9.36: color swatch, positioned to the LEFT of the sort arrows.
                        Clicking opens the palette. Dotted-outline circle when unset,
                        filled circle in the chosen color otherwise. Rendered for every
                        type including the protected `document` fallback. */}
                    <Popover>
                      <PopoverTrigger asChild>
                        {/* v0.9.36.2: replaced the tiny outlined circle with an
                            eyedropper icon button so the color-picker trigger
                            reads unambiguously on all themes. When a color is
                            set, the eyedropper is tinted with that color and a
                            matching dot appears at the bottom-right; when no
                            color is set, the icon renders muted like every
                            other icon button in this row. */}
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="relative"
                          aria-label={type.color ? `Change color for ${type.label}` : `Set color for ${type.label}`}
                          title={type.color ? `Color: ${type.color}` : "Set color"}
                          data-testid={`button-doc-type-color-${type.key}`}
                        >
                          <Pipette
                            className="h-4 w-4"
                            style={type.color ? { color: type.color } : undefined}
                          />
                          {type.color && (
                            <span
                              className="absolute bottom-1 right-1 h-1.5 w-1.5 rounded-full border border-background"
                              style={{ backgroundColor: type.color }}
                              aria-hidden="true"
                            />
                          )}
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent align="end" className="w-auto p-3">
                        <DocumentTypeColorPicker
                          value={type.color}
                          previewLabel={type.label}
                          onChange={(next) => colorMutation.mutate({ key: type.key, color: next })}
                          testId={`doc-type-color-picker-${type.key}`}
                        />
                      </PopoverContent>
                    </Popover>
                    {data.sort_mode === "importance" && (
                      <div className="flex">
                        <Button size="icon" variant="ghost" onClick={() => move(index, -1)} disabled={index === 0 || orderMutation.isPending} aria-label={`Move ${type.label} up`}>
                          <ArrowUp className="h-4 w-4" />
                        </Button>
                        <Button size="icon" variant="ghost" onClick={() => move(index, 1)} disabled={index === data.types.length - 1 || orderMutation.isPending} aria-label={`Move ${type.label} down`}>
                          <ArrowDown className="h-4 w-4" />
                        </Button>
                      </div>
                    )}
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => { setEditing(type.key); setEditLabel(type.label); }}
                      disabled={type.key === "document"}
                      aria-label={`Rename ${type.label}`}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => setDeleting(type)}
                      disabled={type.key === "document"}
                      aria-label={`Delete ${type.label}`}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </>
                )}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <AlertDialog open={Boolean(deleting)} onOpenChange={(open) => { if (!open) setDeleting(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.label}?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting?.document_count
                ? `${deleting.document_count} document${deleting.document_count === 1 ? "" : "s"} will be changed to Document.`
                : "No documents currently use this type."}
              {" "}This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleting && deleteMutation.mutate(deleting.key)}
              data-testid="button-confirm-delete-document-type"
            >
              Delete type
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
