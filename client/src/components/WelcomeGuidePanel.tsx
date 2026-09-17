import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { BookOpen, Loader2, RefreshCw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { useQueryClient } from "@tanstack/react-query";

// v1.0.15: Settings > About panel that exposes a single action:
// "Reinstall welcome guide". POSTs to /api/system/reinstall-welcome-guide,
// which wipes the seeded doc (id "seed-readme-v1") and re-ingests the
// bundled PDF from <APP>/welcome-guide/. Also invalidates /api/documents,
// /api/stats, and /api/facets so the Library and Query pages reflect the
// restored doc immediately.
//
// The seed doc is normally created on first boot; this panel is the manual
// path back to a known-good state after the user removes it from the
// Library.
export function WelcomeGuidePanel() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [pending, setPending] = useState(false);

  const reinstall = async () => {
    setPending(true);
    try {
      const res = await apiRequest("POST", "/api/system/reinstall-welcome-guide");
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body?.ok === false) {
        throw new Error(body?.error || `HTTP ${res.status}`);
      }
      qc.invalidateQueries({ queryKey: ["/api/stats"] });
      qc.invalidateQueries({ queryKey: ["/api/documents"] });
      qc.invalidateQueries({ queryKey: ["/api/facets"] });
      toast({
        title: "Welcome guide reinstalled",
        description: "Open the Library tab to read it.",
      });
    } catch (err: any) {
      toast({
        title: "Reinstall failed",
        description: err?.message ?? "Unknown error",
        variant: "destructive",
      });
    } finally {
      setPending(false);
    }
  };

  return (
    <Card data-testid="card-welcome-guide">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <BookOpen className="h-4 w-4 text-primary" />
          Welcome Guide
        </CardTitle>
        <CardDescription className="text-xs">
          The Welcome Guide is added to your library on first launch. Remove
          it from the Library tab any time; if you later want it back, use
          the button below to reinstall the bundled copy.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button
          variant="outline"
          size="sm"
          onClick={reinstall}
          disabled={pending}
          data-testid="button-reinstall-welcome-guide"
        >
          {pending ? (
            <>
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              Reinstalling…
            </>
          ) : (
            <>
              <RefreshCw className="mr-2 h-3.5 w-3.5" />
              Reinstall welcome guide
            </>
          )}
        </Button>
      </CardContent>
    </Card>
  );
}
