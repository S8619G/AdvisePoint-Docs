import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronsUpDown, Plus, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
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

// LocalStorage key for "last-used" product family prefill. Mirrors the model
// combobox pattern (see ProductModelCombobox.tsx) so both fields feel the same
// to a field tech doing a batch upload.
export const LAST_USED_FAMILY_KEY = "apd:upload:lastProductFamily";

interface FacetsResponse {
  product_families?: string[];
}

interface ProductFamilyComboboxProps {
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
 * Combobox for the optional `product_family` field on the upload page and in
 * the Library edit dialog. Mirrors ProductModelCombobox behaviour exactly:
 * fetches known families from /api/facets, sorts last-used first, allows free
 * text entry, and offers an "Add: <value>" affordance when the typed value is
 * not already in the list.
 */
export function ProductFamilyCombobox({
  value,
  onChange,
  placeholder = "Not set",
  className,
  testId = "combobox-product-family",
  disabled,
}: ProductFamilyComboboxProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const facets = useQuery<FacetsResponse>({
    queryKey: ["/api/facets"],
    // stale-while-revalidate — facets change rarely and cheaply refetch on new upload
    staleTime: 60_000,
  });

  const knownFamilies = useMemo(() => {
    const list = facets.data?.product_families ?? [];
    return Array.from(new Set(list.filter((m) => typeof m === "string" && m.trim())));
  }, [facets.data]);

  // Sort: last-used first (if present), then rest alphabetically.
  const sortedFamilies = useMemo(() => {
    let lastUsed = "";
    try {
      lastUsed = localStorage.getItem(LAST_USED_FAMILY_KEY) ?? "";
    } catch {
      /* localStorage disabled — degrade gracefully */
    }
    const rest = knownFamilies
      .filter((m) => m !== lastUsed)
      .sort((a, b) => a.localeCompare(b));
    return lastUsed && knownFamilies.includes(lastUsed) ? [lastUsed, ...rest] : rest;
  }, [knownFamilies]);

  const trimmed = search.trim();
  const exactMatch = trimmed
    ? sortedFamilies.some((m) => m.toLowerCase() === trimmed.toLowerCase())
    : false;

  const commitSelection = (next: string) => {
    const clean = next.trim();
    if (!clean) return;
    onChange(clean);
    try {
      localStorage.setItem(LAST_USED_FAMILY_KEY, clean);
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
            placeholder="Search or type a new family…"
            value={search}
            onValueChange={setSearch}
            data-testid={`${testId}-input`}
          />
          <CommandList>
            {facets.isLoading && (
              <div className="flex items-center gap-2 px-3 py-4 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Loading known families…
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

            {!facets.isLoading && trimmed && !exactMatch && sortedFamilies.length > 0 && (
              <CommandSeparator />
            )}

            {!facets.isLoading && sortedFamilies.length === 0 && !trimmed && (
              <CommandEmpty>
                No families on file yet — type one to add it.
              </CommandEmpty>
            )}

            {!facets.isLoading && sortedFamilies.length > 0 && (
              <CommandGroup heading="Existing families">
                {sortedFamilies
                  .filter((m) =>
                    trimmed
                      ? m.toLowerCase().includes(trimmed.toLowerCase())
                      : true,
                  )
                  .slice(0, 200)
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
                  !sortedFamilies.some((m) =>
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

/** Convenience: read the last-used family at page mount without importing keys. */
export function readLastUsedProductFamily(): string {
  try {
    return localStorage.getItem(LAST_USED_FAMILY_KEY) ?? "";
  } catch {
    return "";
  }
}
