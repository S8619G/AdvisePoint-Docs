import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronsUpDown, Plus, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";

// LocalStorage key for "last-used" product model prefill.
// Kept in one place so any caller can clear it if we ever ship a Reset preferences.
export const LAST_USED_MODEL_KEY = "apd:upload:lastProductModel";

// v0.9.30: hoisted from pages/upload.tsx so the Library edit dialog can render
// the same red "(Required)" hint next to fields that must be filled in.
// Field techs kept missing the old trailing-asterisk marker and got "upload
// failed" errors on click; this makes the requirement unmistakable.
export function RequiredField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span>{label}</span>
        <span className="font-semibold uppercase tracking-wide text-red-600 dark:text-red-400">
          (Required)
        </span>
      </Label>
      {children}
    </div>
  );
}

interface FacetsResponse {
  product_models?: string[];
}

interface ProductModelComboboxProps {
  value: string;
  onChange: (next: string) => void;
  /** Rendered when the field is empty. */
  placeholder?: string;
  /** Extra classes to merge onto the trigger button. */
  className?: string;
  /** Test id for the trigger button. */
  testId?: string;
  /** Disables the whole control (e.g. during upload). */
  disabled?: boolean;
}

/**
 * Combobox for the required `product_model` field on the upload page.
 *
 * Behaviour:
 * - Fetches existing distinct models from /api/facets (React Query caches them).
 * - Empty click shows the full list, sorted by last-used first, then alphabetical.
 * - Typing filters the list live; a case-insensitive substring match on model names.
 * - Typing something that doesn't exist surfaces an "Add: <value>" affordance at
 *   the top, so users can create a new model with the same Enter key they'd use
 *   to pick an existing one.
 * - Freeform typing without opening the popover still works — the trigger IS the
 *   input, and Escape/blur commits the current text.
 */
export function ProductModelCombobox({
  value,
  onChange,
  placeholder = "Not set",
  className,
  testId = "combobox-product-model",
  disabled,
}: ProductModelComboboxProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const facets = useQuery<FacetsResponse>({
    queryKey: ["/api/facets"],
    // stale-while-revalidate — facets change rarely and cheaply refetch on new upload
    staleTime: 60_000,
  });

  const knownModels = useMemo(() => {
    const list = facets.data?.product_models ?? [];
    // De-dupe defensively; server already returns unique, but never trust the wire.
    return Array.from(new Set(list.filter((m) => typeof m === "string" && m.trim())));
  }, [facets.data]);

  // Sort: last-used first (if present), then rest alphabetically. This keeps the
  // "batch of the same model" workflow one keystroke long.
  const sortedModels = useMemo(() => {
    let lastUsed = "";
    try {
      lastUsed = localStorage.getItem(LAST_USED_MODEL_KEY) ?? "";
    } catch {
      /* localStorage disabled — degrade gracefully */
    }
    const rest = knownModels
      .filter((m) => m !== lastUsed)
      .sort((a, b) => a.localeCompare(b));
    return lastUsed && knownModels.includes(lastUsed) ? [lastUsed, ...rest] : rest;
  }, [knownModels]);

  // The trimmed search string, used both for filtering and for the "Add new" affordance.
  const trimmed = search.trim();
  const exactMatch = trimmed
    ? sortedModels.some((m) => m.toLowerCase() === trimmed.toLowerCase())
    : false;

  const commitSelection = (next: string) => {
    const clean = next.trim();
    if (!clean) return;
    onChange(clean);
    try {
      localStorage.setItem(LAST_USED_MODEL_KEY, clean);
    } catch {
      /* localStorage disabled — silently continue */
    }
    setOpen(false);
    setSearch("");
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          data-testid={testId}
          className={cn(
            "w-full justify-between font-normal",
            !value && "text-muted-foreground",
            className,
          )}
        >
          <span className="truncate">
            {value || placeholder}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[--radix-popover-trigger-width] p-0"
        align="start"
      >
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search or type a new model…"
            value={search}
            onValueChange={setSearch}
            data-testid={`${testId}-input`}
          />
          <CommandList>
            {facets.isLoading && (
              <div className="flex items-center gap-2 px-3 py-4 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Loading known models…
              </div>
            )}

            {!facets.isLoading && trimmed && !exactMatch && (
              <CommandGroup heading="Create new">
                <CommandItem
                  value={`__create__::${trimmed}`}
                  onSelect={() => commitSelection(trimmed)}
                  data-testid={`${testId}-create`}
                  className="cursor-pointer"
                >
                  <Plus className="mr-2 h-4 w-4 text-primary" />
                  <span>
                    Add: <strong className="font-medium">{trimmed}</strong>
                  </span>
                </CommandItem>
              </CommandGroup>
            )}

            {!facets.isLoading && trimmed && !exactMatch && sortedModels.length > 0 && (
              <CommandSeparator />
            )}

            {!facets.isLoading && sortedModels.length === 0 && !trimmed && (
              <CommandEmpty>
                No models on file yet — type one to add it.
              </CommandEmpty>
            )}

            {!facets.isLoading && sortedModels.length > 0 && (
              <CommandGroup heading="Existing models">
                {sortedModels
                  .filter((m) =>
                    trimmed
                      ? m.toLowerCase().includes(trimmed.toLowerCase())
                      : true,
                  )
                  .slice(0, 200) // sanity cap; a field-tech team is unlikely to exceed
                  .map((m) => (
                    <CommandItem
                      key={m}
                      value={m}
                      onSelect={() => commitSelection(m)}
                      data-testid={`${testId}-item-${m}`}
                      className="cursor-pointer"
                    >
                      <Check
                        className={cn(
                          "mr-2 h-4 w-4",
                          value === m ? "opacity-100" : "opacity-0",
                        )}
                      />
                      <span className="truncate">{m}</span>
                    </CommandItem>
                  ))}
                {trimmed &&
                  !sortedModels.some((m) =>
                    m.toLowerCase().includes(trimmed.toLowerCase()),
                  ) &&
                  !exactMatch && (
                    <div className="px-3 py-2 text-xs text-muted-foreground">
                      No existing matches — the "Add" option above will create it.
                    </div>
                  )}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** Convenience: read the last-used model at page mount without importing keys. */
export function readLastUsedProductModel(): string {
  try {
    return localStorage.getItem(LAST_USED_MODEL_KEY) ?? "";
  } catch {
    return "";
  }
}
