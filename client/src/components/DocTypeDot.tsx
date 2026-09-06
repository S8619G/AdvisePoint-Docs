// -----------------------------------------------------------------------------
// DocTypeDot
//
// v0.9.36: Small accent dot that shows a document type's color wherever the
// type appears (library cards, filter dropdowns, upload picker, query results).
// When the type has no color set, this renders nothing — keeping the UI clean
// for users who don't customize colors.
//
// Callers pass either an explicit hex color or `null` for "no color". The
// wrapping caller decides whether to look the color up by key or hard-pass it,
// which lets tight loops avoid re-searching the type registry on every row.
// -----------------------------------------------------------------------------

import { cn } from "@/lib/utils";

interface DocTypeDotProps {
  color: string | null | undefined;
  className?: string;
}

export function DocTypeDot({ color, className }: DocTypeDotProps) {
  if (!color) return null;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block h-2 w-2 shrink-0 rounded-full border border-border/40",
        className,
      )}
      style={{ backgroundColor: color }}
      data-testid="doc-type-dot"
    />
  );
}
