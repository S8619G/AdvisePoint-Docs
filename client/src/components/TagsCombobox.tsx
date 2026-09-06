// v0.9.30 - Shared TagsCombobox extracted from pages/upload.tsx.
//
// Chip input with global autocomplete from /api/facets tags. Works both on
// standalone pages (Upload) and inside a Dialog (Library edit). Three
// popover-behavior bugs from v0.9.29 fixed here:
//
//   1. Flicker on first click. The old version wrapped the input container
//      in <PopoverTrigger asChild> AND also called setOpen(true) on click.
//      Radix's own click-toggle plus our manual open call raced and the
//      popover briefly opened/closed. Fix: use <PopoverAnchor> instead of
//      <PopoverTrigger>, drive `open` from focus/click only, and let Radix
//      position off the anchor. The trigger no longer double-handles the
//      click.
//
//   2. Outside click didn't dismiss inside a Dialog. Library's DialogContent
//      has `onClick={e => e.stopPropagation()}` (needed to keep card-link
//      navigation from firing). Radix Popover installs onPointerDownOutside
//      on the portaled content, but that fires only if the event actually
//      propagates. We force it here by attaching onInteractOutside on
//      PopoverContent, and also by installing a document-level pointerdown
//      listener while the popover is open (belt-and-suspenders).
//
//   3. Mouse wheel didn't scroll the suggestion list inside a Dialog. Radix
//      Dialog modal-mode locks body scroll, and wheel events bubbling out of
//      the portaled popover were being consumed by the lock. Fix:
//      onWheel={e => e.stopPropagation()} on PopoverContent so wheel over
//      the suggestions never reaches the lock.
//
// External contract unchanged from the previous inline component:
//   value / onChange are the same comma-separated string the plain Input
//   used. buildMetadataPayload and Meta shape don't change.

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { X } from "lucide-react";

function splitTagList(s: string): string[] {
  if (!s) return [];
  return s.split(",").map((t) => t.trim()).filter(Boolean);
}

function joinTagList(list: string[]): string {
  return list.join(", ");
}

export function TagsCombobox({
  value,
  onChange,
  testId,
  showLabel = true,
}: {
  value: string;
  onChange: (next: string) => void;
  testId?: string;
  showLabel?: boolean;
}) {
  const tags = useMemo(() => splitTagList(value), [value]);
  const tagsLower = useMemo(
    () => new Set(tags.map((t) => t.toLowerCase())),
    [tags]
  );

  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const facets = useQuery<{ tags?: string[] }>({
    queryKey: ["/api/facets"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/facets");
      return res.json();
    },
    staleTime: 30_000,
  });

  const suggestions = useMemo(() => {
    const all = facets.data?.tags ?? [];
    const q = input.trim().toLowerCase();
    return all
      .filter((t) => !tagsLower.has(t.toLowerCase()))
      .filter((t) => (q ? t.toLowerCase().includes(q) : true))
      .slice(0, 50);
  }, [facets.data, input, tagsLower]);

  const commit = (raw: string) => {
    const t = raw.trim();
    if (!t) return;
    if (tagsLower.has(t.toLowerCase())) {
      setInput("");
      return;
    }
    onChange(joinTagList([...tags, t]));
    setInput("");
  };

  const remove = (t: string) => {
    onChange(joinTagList(tags.filter((x) => x !== t)));
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === "," || e.key === "Tab") {
      if (input.trim()) {
        e.preventDefault();
        commit(input);
      }
    } else if (e.key === "Backspace" && input === "" && tags.length > 0) {
      e.preventDefault();
      remove(tags[tags.length - 1]);
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      setOpen(false);
    }
  };

  // Belt-and-suspenders outside-click detector. Fires even when a parent
  // Dialog has stopPropagation on its click handler, because we listen at
  // document level in the capture phase.
  useEffect(() => {
    if (!open) return;
    const onDocDown = (ev: PointerEvent) => {
      const target = ev.target as Node | null;
      if (!target) return;
      const inside = containerRef.current?.contains(target);
      // Popover portal renders outside our container; check by attribute so
      // clicking a suggestion doesn't close before onSelect fires.
      const popover = (target as HTMLElement).closest?.(
        "[data-tags-combobox-popover]"
      );
      if (!inside && !popover) setOpen(false);
    };
    document.addEventListener("pointerdown", onDocDown, true);
    return () =>
      document.removeEventListener("pointerdown", onDocDown, true);
  }, [open]);

  const showList = open && suggestions.length > 0;

  return (
    <div className="space-y-1.5" ref={containerRef}>
      {showLabel && (
        <Label className="text-xs text-muted-foreground">Tags</Label>
      )}
      <Popover open={showList} onOpenChange={setOpen}>
        <PopoverAnchor asChild>
          <div
            className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1.5 text-sm focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background"
            data-testid={testId ?? "input-tags-combobox"}
            onClick={() => {
              setOpen(true);
              inputRef.current?.focus();
            }}
          >
            {tags.map((t) => (
              <Badge
                key={t}
                variant="secondary"
                className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium"
                data-testid={`chip-tag-${t}`}
              >
                <span>{t}</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    remove(t);
                  }}
                  className="rounded-sm hover:bg-muted-foreground/10"
                  aria-label={`Remove ${t}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                if (!open) setOpen(true);
              }}
              onFocus={() => setOpen(true)}
              onKeyDown={onKeyDown}
              placeholder={
                tags.length === 0 ? "Type a tag, press Enter to add" : ""
              }
              className="min-w-[8ch] flex-1 border-0 bg-transparent p-0 text-sm focus:outline-none focus:ring-0"
            />
          </div>
        </PopoverAnchor>
        <PopoverContent
          data-tags-combobox-popover=""
          className="w-[--radix-popover-trigger-width] p-0"
          align="start"
          sideOffset={4}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onInteractOutside={(e) => {
            // If interaction was on our own container (typing/clicking in
            // the input), don't dismiss - the container's onClick handles it.
            const target = e.target as Node | null;
            if (target && containerRef.current?.contains(target)) {
              e.preventDefault();
              return;
            }
            setOpen(false);
          }}
          onWheel={(e) => e.stopPropagation()}
        >
          <Command shouldFilter={false}>
            <CommandList>
              <CommandGroup heading="Previously used">
                {suggestions.map((t) => (
                  <CommandItem
                    key={t}
                    value={t}
                    onSelect={() => commit(t)}
                    className="cursor-pointer"
                  >
                    {t}
                  </CommandItem>
                ))}
              </CommandGroup>
              {suggestions.length === 0 && (
                <CommandEmpty>No previously used tags match.</CommandEmpty>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
