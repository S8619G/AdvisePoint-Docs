import { useMemo, useState } from "react";
import { Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fixTitle, basicFilenameCleanup } from "@/lib/fix-title";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";

// -----------------------------------------------------------------------------
// Fix Title button (v1.1.0)
// -----------------------------------------------------------------------------
//
// Runs the LOCKED filename parser (client/src/lib/fix-title.ts) over the raw
// uploaded filename and replaces the Title field with a readable version.
//
// Two invariants from the spec, both load-bearing:
//
//  1. Every click parses `originalFilename` -- NEVER the current Title value.
//     Re-parsing an already-parsed title is not idempotent and would degrade
//     it on the second click.
//  2. If the user has hand-edited the Title, confirm before clobbering it. The
//     Title counts as NOT hand-edited when it matches either the parsed output
//     (they already clicked Fix Title) or the basic filename cleanup (still the
//     machine-derived default). Anything else is the user's own wording and
//     earns a confirmation dialog showing both values side by side.
// -----------------------------------------------------------------------------

export function FixTitleButton({
  originalFilename,
  currentTitle,
  onApply,
}: {
  originalFilename: string;
  currentTitle: string;
  onApply: (next: string) => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Always derived from the immutable original filename.
  const parsed = useMemo(() => fixTitle(originalFilename).title, [originalFilename]);

  const handleClick = () => {
    const current = currentTitle.trim();
    const basic = basicFilenameCleanup(originalFilename);
    // Blank counts as untouched -- the server fills it from the filename anyway.
    const untouched =
      current === '' ||
      current === parsed ||
      current === basic ||
      current === originalFilename;
    if (untouched) {
      onApply(parsed);
      return;
    }
    setConfirmOpen(true);
  };

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleClick}
        className="shrink-0"
        data-testid="button-fix-title"
        title={`Suggest a clean title from ${originalFilename}`}
      >
        <Wand2 className="mr-1.5 h-3.5 w-3.5" />
        Fix Title
      </Button>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent data-testid="alert-fix-title-overwrite">
          <AlertDialogHeader>
            <AlertDialogTitle>Replace your edited title with the parsed version?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>You have edited this title by hand. Fix Title would replace it.</p>
                <div className="space-y-1">
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">
                    Current title
                  </div>
                  <div className="rounded-md border border-border bg-muted/40 px-2 py-1.5 font-mono text-xs break-all">
                    {currentTitle}
                  </div>
                </div>
                <div className="space-y-1">
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">
                    Proposed title
                  </div>
                  <div className="rounded-md border border-border bg-muted/40 px-2 py-1.5 font-mono text-xs break-all">
                    {parsed}
                  </div>
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-fix-title-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmOpen(false);
                onApply(parsed);
              }}
              data-testid="button-fix-title-replace"
            >
              Replace
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

