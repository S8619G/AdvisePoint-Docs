// -----------------------------------------------------------------------------
// TitleColorPicker
//
// v0.9.30: Optional accent color for a document's rendered title. Users pick
// from a small preset palette (12 swatches) that reads well on both light and
// dark backgrounds, plus a "Custom…" native color input for the rare case
// they need a specific brand color, plus a "Reset" chip to clear back to the
// default text color.
//
// State model:
//   value === null | undefined  → default text color (no override)
//   value === "#rrggbb"         → apply that color to the rendered title
//
// The picker does NOT try to enforce contrast against the current background.
// Techs sometimes deliberately pick a bright color to make one manual stand
// out in a long list, and we don't want to fight them on it.
// -----------------------------------------------------------------------------

import { useRef } from "react";
import { Check, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

interface TitleColorPickerProps {
  value: string | null | undefined;
  onChange: (next: string | null) => void;
  testId?: string;
}

// The 12 presets are grouped roughly by hue and chosen so every swatch is
// visible on both light and dark surfaces without further tuning.
const PRESETS: { label: string; hex: string }[] = [
  { label: "Black",     hex: "#000000" },
  { label: "Dark gray", hex: "#3F3F46" },
  { label: "Red",       hex: "#C42B1C" },
  { label: "Orange",    hex: "#F7630C" },
  { label: "Amber",     hex: "#B89500" },
  { label: "Green",     hex: "#107C10" },
  { label: "Teal",      hex: "#00A5A5" },
  { label: "Blue",      hex: "#0078D4" },
  { label: "Navy",      hex: "#1F3A93" },
  { label: "Purple",    hex: "#8764B8" },
  { label: "Pink",      hex: "#C239B3" },
  { label: "Brown",     hex: "#7A4F01" },
];

// Normalize any incoming value to a 7-char lowercase hex ("#rrggbb"). Anything
// invalid is treated as null so the equality check below stays stable.
function normalizeHex(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = v.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(s) ? s : null;
}

export function TitleColorPicker({ value, onChange, testId }: TitleColorPickerProps) {
  const currentHex = normalizeHex(value);
  const isCustom =
    currentHex !== null && !PRESETS.some((p) => p.hex.toLowerCase() === currentHex);
  const customInputRef = useRef<HTMLInputElement>(null);

  const testIdRoot = testId ?? "title-color-picker";

  return (
    <div className="space-y-2" data-testid={testIdRoot}>
      <div className="flex flex-wrap items-center gap-1.5">
        {PRESETS.map((p) => {
          const on = currentHex === p.hex.toLowerCase();
          return (
            <button
              key={p.hex}
              type="button"
              onClick={() => onChange(p.hex)}
              className={cn(
                "relative h-6 w-6 rounded-full border-2 transition-transform",
                "hover:scale-110 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
                on ? "border-ring" : "border-border/60",
              )}
              style={{ backgroundColor: p.hex }}
              title={p.label}
              aria-label={`Set title color to ${p.label}`}
              aria-pressed={on}
              data-testid={`${testIdRoot}-preset-${p.label.toLowerCase().replace(/\s+/g, "-")}`}
            >
              {on && (
                // The check overlay is drawn in a color that reads on any preset.
                // Presets are all mid-to-dark, so white always contrasts well.
                <Check
                  className="absolute inset-0 m-auto h-3.5 w-3.5"
                  style={{ color: "#ffffff" }}
                  strokeWidth={3}
                />
              )}
            </button>
          );
        })}

        {/* Custom color: rendered as a swatch with the current custom value if
            set, or as a small "..." placeholder otherwise. Clicking opens the
            native color picker. */}
        <label
          className={cn(
            "relative flex h-6 w-6 cursor-pointer items-center justify-center rounded-full border-2 text-[9px] font-semibold",
            isCustom ? "border-ring" : "border-dashed border-border/60 text-muted-foreground",
          )}
          style={isCustom ? { backgroundColor: currentHex ?? undefined } : undefined}
          title="Custom color"
          data-testid={`${testIdRoot}-custom`}
        >
          {!isCustom && "···"}
          {isCustom && (
            <Check
              className="absolute inset-0 m-auto h-3.5 w-3.5"
              style={{ color: "#ffffff" }}
              strokeWidth={3}
            />
          )}
          <input
            ref={customInputRef}
            type="color"
            value={currentHex ?? "#000000"}
            onChange={(e) => onChange(e.target.value.toLowerCase())}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            aria-label="Pick a custom title color"
          />
        </label>

        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-2 text-[11px] text-muted-foreground hover:text-foreground"
          onClick={() => onChange(null)}
          disabled={currentHex === null}
          data-testid={`${testIdRoot}-reset`}
          title="Reset to default color"
        >
          <RotateCcw className="h-3 w-3" />
          Reset
        </Button>
      </div>

      {/* Live preview so users see the effect before saving. Uses the rendered
          title's actual typography (small caps of the field label). */}
      <div className="text-[11px] text-muted-foreground">
        Preview:{" "}
        <span
          className="font-medium text-sm"
          style={{ color: currentHex ?? undefined }}
          data-testid={`${testIdRoot}-preview`}
        >
          Sample document title
        </span>
      </div>
    </div>
  );
}
