// v0.9.20 - Viewer preferences panel: mouse-wheel action + scroll direction.
//
// Lives on the Settings > About tab (see pages/schema.tsx). Also mirrored by
// the inline radio in the page viewer's footer - both share `useViewerPrefs`
// so a change in either place is reflected in the other immediately.

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { useViewerPrefs, type WheelAction, type WheelDirection } from "@/lib/viewer-prefs";

function Radio({
  checked,
  onSelect,
  label,
  description,
  testId,
}: {
  checked: boolean;
  onSelect: () => void;
  label: string;
  description: string;
  testId: string;
}) {
  return (
    <label
      className={
        "flex items-start gap-2 rounded-md border p-3 cursor-pointer transition-colors " +
        (checked ? "border-primary/70 bg-primary/5" : "border-border hover:bg-accent/50")
      }
    >
      <input
        type="radio"
        checked={checked}
        onChange={onSelect}
        className="mt-0.5"
        data-testid={testId}
      />
      <div className="space-y-0.5">
        <div className="text-xs font-medium text-foreground">{label}</div>
        <div className="text-[11px] text-muted-foreground">{description}</div>
      </div>
    </label>
  );
}

export function ViewerPrefsPanel() {
  const [prefs, setPrefs] = useViewerPrefs();

  const setAction = (v: WheelAction) => setPrefs({ wheelAction: v });
  const setDirection = (v: WheelDirection) => setPrefs({ wheelDirection: v });

  return (
    <Card data-testid="card-viewer-prefs">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Page viewer</CardTitle>
        <CardDescription className="text-xs">
          Controls for the original-page viewer. These settings persist locally on this PC.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div>
          <div className="text-xs font-medium text-foreground mb-2">
            Mouse wheel action
          </div>
          <div
            className="grid gap-2 sm:grid-cols-3"
            role="radiogroup"
            aria-label="Mouse wheel action"
            data-testid="radiogroup-wheel-action"
          >
            <Radio
              checked={prefs.wheelAction === "scroll"}
              onSelect={() => setAction("scroll")}
              label="Scroll page image (default)"
              description="Wheel scrolls up and down through the currently zoomed page. Ctrl or Cmd + wheel still zooms."
              testId="radio-wheel-scroll"
            />
            <Radio
              checked={prefs.wheelAction === "zoom"}
              onSelect={() => setAction("zoom")}
              label="Zoom toward cursor"
              description="Wheel zooms in and out of the page image. Useful for quick, precise zoom without leaving the mouse."
              testId="radio-wheel-zoom"
            />
            <Radio
              checked={prefs.wheelAction === "page"}
              onSelect={() => setAction("page")}
              label="Turn pages"
              description="Wheel down goes to the next page, wheel up to the previous. Toolbar buttons still work."
              testId="radio-wheel-page"
            />
          </div>
        </div>

        <div>
          <div className="text-xs font-medium text-foreground mb-2">
            Scroll direction
          </div>
          <div
            className="grid gap-2 sm:grid-cols-2"
            role="radiogroup"
            aria-label="Mouse wheel scroll direction"
            data-testid="radiogroup-wheel-direction"
          >
            <Radio
              checked={prefs.wheelDirection === "natural"}
              onSelect={() => setDirection("natural")}
              label="Natural (default)"
              description="Wheel down moves the view down. Matches Windows' default scroll behavior."
              testId="radio-direction-natural"
            />
            <Radio
              checked={prefs.wheelDirection === "inverted"}
              onSelect={() => setDirection("inverted")}
              label="Inverted"
              description="Wheel down moves the view up. Matches macOS-style natural-scroll or reverse-scroll setups."
              testId="radio-direction-inverted"
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
