// v1.2.4 (item 3) -- Settings > About surface for the product-value manager.
// Wraps a single button that opens ProductValuesDialog. Lives next to
// WelcomeGuidePanel in the About tab; both are narrow cards sitting side by
// side on medium+ screens (see schema.tsx About tab grid).
//
// Field-test feedback (v1.2.3): users looking for "manage values" hunted
// on the Library tab and did not find it -- the previous placement in the
// sort/filter toolbar was easy to miss and the button copy did not signal
// that it was a config surface. Moving it to Settings > About with a real
// card of its own gives it visibility that matches the frequency of use.
//
// The dialog itself is unchanged in structure -- only its entry point
// moved. The one behavior change this release is a per-row Delete button
// in the dialog (see ProductValuesDialog.tsx COMPANION NOTE for the
// rationale and the "reassign, don't cascade" contract).

import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tags } from "lucide-react";
import { ProductValuesDialog } from "@/components/ProductValuesDialog";

export function ManageValuesPanel() {
  const [open, setOpen] = useState(false);
  return (
    <Card data-testid="card-manage-values">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Tags className="h-4 w-4 text-primary" />
          Manage values
        </CardTitle>
        <CardDescription className="text-xs">
          Rename, merge, or delete Product model and Product family values
          across every document at once. Deletes never lose a document -- you
          pick another value to merge into, or clear the field on those
          documents.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setOpen(true)}
          data-testid="button-open-manage-values"
          className="gap-1.5"
        >
          <Tags className="h-3.5 w-3.5" />
          Manage values
        </Button>
      </CardContent>
      <ProductValuesDialog open={open} onOpenChange={setOpen} />
    </Card>
  );
}
