// -----------------------------------------------------------------------------
// DocumentTypeColorPicker
//
// v0.9.36: Optional accent color for a document type. Users pick from the same
// 12-swatch palette we use for title color, plus a custom color input, plus a
// Reset chip to clear back to "no color". Independent from the per-document
// title color: a document typed as "Guide" (green dot) can still have a red
// title if the uploader wants both signals.
//
// State model:
//   value === null | undefined  → no color assigned (dot omitted in the UI)
//   value === "#rrggbb"         → apply that color as the type's accent dot
//
// Kept as a duplicate of TitleColorPicker for now (v0.9.36 ship discipline);
// if a third color feature appears, both should collapse into a shared
// ColorSwatchPicker.
// -----------------------------------------------------------------------------

import { useRef } from "react";
import { Check, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

interface DocumentTypeColorPickerProps {
  value: string | null | undefined;
  onChange: (next: string | null) => void;
  // The label shown in the "Preview:" row (defaults to "Document type").
  previewLabel?: string;
  testId?: string;
}

// Same 12 presets as TitleColorPicker. If these ever change, update both.
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

function normalizeHex(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = v.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(s) ? s : null;
}

export function DocumentTypeColorPicker({
  value,
  onChange,
  previewLabel,
  testId,
}: DocumentTypeColorPickerProps) {
  const currentHex = normalizeHex(value);
  const isCustom =
    currentHex !== null && !PRESETS.some((p) => p.hex.toLowerCase() === currentHex);
  const customInputRef = useRef<HTMLInputElement>(null);

  const testIdRoot = testId ?? "doc-type-color-picker";

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
              aria-label={`Set document type color to ${p.label}`}
              aria-pressed={on}
              data-testid={`${testIdRoot}-preset-${p.label.toLowerCase().replace(/\s+/g, "-")}`}
            >
              {on && (
                <Check
                  className="absolute inset-0 m-auto h-3.5 w-3.5"
                  style={{ color: "#ffffff" }}
                  strokeWidth={3}
                />
              )}
            </button>
          );
        })}

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
            aria-label="Pick a custom document type color"
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
          title="Clear color"
        >
          <RotateCcw className="h-3 w-3" />
          Clear
        </Button>
      </div>

      {/* Preview shows the accent dot the way it will appear in the Library and
          Query surfaces, next to the type's label. */}
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        Preview:
        <span
          className="inline-block h-2 w-2 rounded-full border border-border/40"
          style={{ backgroundColor: currentHex ?? "transparent" }}
          data-testid={`${testIdRoot}-preview-dot`}
        />
        <span className="text-foreground" data-testid={`${testIdRoot}-preview-label`}>
          {previewLabel ?? "Document type"}
        </span>
      </div>
    </div>
  );
}
