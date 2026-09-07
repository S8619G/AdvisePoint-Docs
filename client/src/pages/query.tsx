import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useStoreField } from "@/lib/tabStore";
import {
  queryTabStore,
  serializeQueryStateToUrl,
  hydrateQueryStateFromUrl,
  type QueryTabState,
} from "@/lib/queryTabStore";
import { writeHashQuery, readHashQuery } from "@/lib/tabUrlSync";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import {
  Loader2,
  Search,
  ChevronRight,
  ChevronDown,
  Filter as FilterIcon,
  X,
  Copy,
  Printer,
  BookOpen,
  Image as ImageIcon,
  PanelRightOpen,
  PanelRightClose,
  Sparkles,
  Target,
  Zap,
  Info,
  SearchX,
} from "lucide-react";
import { PageViewerDialog } from "@/components/PageViewer";
import { Link } from "wouter";
import { JsonBlock } from "./upload";
import { useDocumentTypes } from "@/lib/documentTypes";
import { DocTypeDot } from "@/components/DocTypeDot";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import { Highlight } from "@/lib/highlight";

// v0.9.23 - full Query page redesign.
//
// Goals set by the user:
//   * Rename clunky filter labels (Top K -> Max results, Hybrid -> Match mode,
//     Max confidentiality -> Show up to).
//   * A real empty state when nothing matches - not 6 unhighlighted cards.
//   * Group results by manual (parent document), with best pages nested inside
//     one parent card so techs stop scrolling through 6 near-duplicates.
//   * Split ranking into Strong matches (highly relevant) and Also relevant
//     (weaker semantic matches) so the eye lands on the best hit first.
//   * Confidence pills (Strong / Moderate / Weak) instead of raw scores.
//   * Optional Preview pane so the tech can read the original page next to
//     the excerpt without opening a modal.
//   * Intent chips - auto-detect error codes, model names, and UI paths in
//     the query and offer to pre-fill matching filters.
//   * Keyboard nav: / to focus, j/k through matches, Enter to expand, Esc to
//     collapse or clear selection.

interface Facets {
  product_models: string[];
  product_versions: string[];
  firmware_versions: string[];
  document_types: string[];
  tenants: string[];
  // v0.9.30: union of every user-supplied tag across the corpus,
  // lowercased and de-duplicated on the server side.
  tags: string[];
}

interface Result {
  score: number;
  chunk: any;
  parent: {
    id: string;
    title: string;
    document_type: string;
    product_model: string;
    product_version: string | null;
    firmware_version: string | null;
  } | null;
}

interface SearchResponse {
  results: Result[];
  total_matched: number;
  filter_applied: any;
  required_phrases?: string[];
}

type MatchMode = "smart" | "phrase" | "semantic";

const EXAMPLE_QUERIES = [
  "how do I bind the printer to LDAP with TLS",
  "what does error E-1042 mean",
  "steps to enable 802.1X authentication",
  "SNMPv3 configuration",
  "firmware update procedure",
];

// Score thresholds for the confidence pill. Calibrated against the hybrid
// scoring in /api/search: score = 0.7 * cosine + 0.3 * keyword-hit-fraction,
// then boosted (≤ 1.5×) for required-phrase repetition and 1.08× for how-to
// intent. Empirically, natural-language queries against the current corpus
// land 0.44–0.65 for good hits; the previous 0.60 / 0.35 cutoffs meant
// "Strong" was almost unreachable. v0.9.28 recalibrates so the tiers reflect
// how the scores actually distribute in the field.
//   Best match   ≥ 0.50  (strong lexical + semantic alignment)
//   Good match   ≥ 0.30  (relevant, worth reading)
//   Weak match   <  0.30  (tangential embedding neighbor)
const STRONG_THRESHOLD = 0.5;
const MODERATE_THRESHOLD = 0.3;

function confidenceTier(score: number): "strong" | "moderate" | "weak" {
  if (score >= STRONG_THRESHOLD) return "strong";
  if (score >= MODERATE_THRESHOLD) return "moderate";
  return "weak";
}

function tierLabel(tier: "strong" | "moderate" | "weak"): string {
  if (tier === "strong") return "Best match";
  if (tier === "moderate") return "Good match";
  return "Weak match";
}

function tierTooltip(tier: "strong" | "moderate" | "weak", score: number): string {
  const scoreStr = `raw score ${score.toFixed(3)}`;
  if (tier === "strong") return `Best match — strong keyword and meaning overlap with your query (${scoreStr}).`;
  if (tier === "moderate") return `Good match — relevant but with weaker keyword overlap or partial phrasing (${scoreStr}).`;
  return `Weak match — the result is only loosely related; skim before trusting (${scoreStr}).`;
}

// Formats page metadata into a compact citation snippet.
function formatPages(page_start?: number | null, page_end?: number | null): string | null {
  if (page_start && page_end && page_start !== page_end) return `pages ${page_start}–${page_end}`;
  if (page_start) return `page ${page_start}`;
  if (page_end) return `page ${page_end}`;
  return null;
}

// Copies text to clipboard with a fallback for older browsers.
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

// Opens a print-only window with the excerpt text + citation, then triggers the print dialog.
function printExcerpt(opts: { title: string; citation: string; body: string }) {
  const w = window.open("", "_blank", "width=800,height=900");
  if (!w) return false;
  const safeTitle = opts.title.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const safeCitation = opts.citation.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const safeBody = opts.body.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  w.document.write(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${safeTitle}</title>
  <style>
    body { font: 14px/1.6 -apple-system, Segoe UI, Roboto, sans-serif; color: #111; padding: 40px; max-width: 780px; margin: auto; }
    h1 { font-size: 16px; margin: 0 0 4px; }
    .cite { color: #555; font-size: 12px; margin-bottom: 24px; padding-bottom: 12px; border-bottom: 1px solid #ddd; }
    pre { white-space: pre-wrap; font: inherit; margin: 0; }
    @media print { body { padding: 0; } }
  </style>
</head>
<body>
  <h1>${safeTitle}</h1>
  <div class="cite">${safeCitation}</div>
  <pre>${safeBody}</pre>
  <script>
    window.addEventListener('load', () => { window.focus(); window.print(); });
  </script>
</body>
</html>`);
  w.document.close();
  return true;
}

// Detects likely-typed intents from the user's raw query string so we can
// suggest one-click filter pre-fills. Matches are conservative (return empty
// arrays rather than false positives) because a wrong suggestion is worse
// than no suggestion.
interface Intents {
  errorCodes: string[];
  productModels: string[];
  uiPaths: string[];
}

function detectIntents(query: string, facets: Facets | undefined): Intents {
  const errorCodes: string[] = [];
  const productModels: string[] = [];
  const uiPaths: string[] = [];

  // Error code shape: letter + optional letters + optional dash/space + digits
  //   E-1042, C6000, F248, JAM-2405
  // Case-insensitive; we upper-case the capture for filter equality.
  const errRe = /\b([A-Z]{1,4})[-\s]?(\d{2,5})\b/gi;
  let em: RegExpExecArray | null;
  const seenErr = new Set<string>();
  while ((em = errRe.exec(query)) !== null) {
    // Skip obvious non-error tokens - years, phone numbers, HTTP codes.
    const digits = em[2];
    if (digits.length === 4 && digits.startsWith("20")) continue; // 2024, 2025...
    const norm = `${em[1].toUpperCase()}-${digits}`;
    if (!seenErr.has(norm)) {
      seenErr.add(norm);
      errorCodes.push(norm);
    }
  }

  // Product models from facets: substring match, case-insensitive, whole word.
  if (facets?.product_models) {
    const lower = query.toLowerCase();
    for (const model of facets.product_models) {
      if (!model) continue;
      // Require the model string to appear as-is (case-insensitive), which is
      // strict enough that "5054" won't match "TASKalfa 5054ci" but a user
      // typing "TASKalfa 5054ci" or "taskalfa 5054ci" both match.
      if (lower.includes(model.toLowerCase())) productModels.push(model);
    }
  }

  // UI paths: "A > B > C" with at least two chevrons and readable segments.
  const pathRe = /([A-Z][A-Za-z0-9 ]{1,30}\s*>\s*[A-Z][A-Za-z0-9 ]{1,30}(?:\s*>\s*[A-Za-z0-9 ]{1,30})*)/g;
  let pm: RegExpExecArray | null;
  while ((pm = pathRe.exec(query)) !== null) {
    const path = pm[1].replace(/\s+>\s+/g, " > ").trim();
    if (path.length > 4 && !uiPaths.includes(path)) uiPaths.push(path);
  }

  return { errorCodes, productModels, uiPaths };
}

interface GroupedResults {
  parentId: string;
  parentTitle: string;
  // v0.9.30: optional accent color for the rendered parent title, so
  // grouped results match the color the user set in Library.
  parentTitleColor: string | null;
  parentModel: string;
  parentFirmware: string | null;
  bestScore: number;
  results: Result[];
}

// Buckets results by parent doc, preserving the best (highest-score) parent
// order at the top. This is the "one card per manual, matching pages nested"
// layout the user asked for.
function groupByParent(results: Result[]): GroupedResults[] {
  const map = new Map<string, GroupedResults>();
  for (const r of results) {
    const pid = r.parent?.id ?? "__orphan";
    const existing = map.get(pid);
    if (existing) {
      existing.results.push(r);
      existing.bestScore = Math.max(existing.bestScore, r.score);
    } else {
      map.set(pid, {
        parentId: pid,
        parentTitle: r.parent?.title ?? "Untitled",
        parentTitleColor: (r.parent as any)?.title_color ?? null,
        parentModel: r.parent?.product_model ?? "",
        parentFirmware: r.parent?.firmware_version ?? null,
        bestScore: r.score,
        results: [r],
      });
    }
  }
  const groups = Array.from(map.values());
  // Sort each group's results by score, then sort groups by their best-score.
  for (const g of groups) g.results.sort((a, b) => b.score - a.score);
  groups.sort((a, b) => b.bestScore - a.bestScore);
  return groups;
}

// v0.9.31: One-shot hydration of the query tab store from the URL. Runs
// module-side so refreshing the page (or arriving via a deep link) fills
// in the store BEFORE the component mounts, which means the initial
// render already reflects the URL state.
let queryStoreHydratedOnce = false;
function hydrateQueryStoreFromHashOnce() {
  if (queryStoreHydratedOnce) return;
  queryStoreHydratedOnce = true;
  const patch = hydrateQueryStateFromUrl(readHashQuery());
  if (Object.keys(patch).length) queryTabStore.setState(patch);
}

export default function Query() {
  const { data: documentTypes } = useDocumentTypes();
  hydrateQueryStoreFromHashOnce();
  const { toast } = useToast();
  const { data: facets } = useQuery<Facets>({ queryKey: ["/api/facets"] });

  // v0.9.31: State lives in queryTabStore so it survives tab switches.
  // useStoreField mimics useState's [value, setValue] shape so the rest
  // of the component reads the same as before.
  const [q, setQ] = useStoreField(queryTabStore, "q");
  const [maxResults, setMaxResults] = useStoreField(queryTabStore, "maxResults");
  const [matchMode, setMatchMode] = useStoreField(queryTabStore, "matchMode");
  const [productModel, setProductModel] = useStoreField(queryTabStore, "productModel");
  const [docType, setDocType] = useStoreField(queryTabStore, "docType");
  const [firmware, setFirmware] = useStoreField(queryTabStore, "firmware");
  const [errorCode, setErrorCode] = useStoreField(queryTabStore, "errorCode");
  const [confidentialityMax, setConfidentialityMax] = useStoreField(queryTabStore, "confidentialityMax");
  // v0.9.30: Tags multi-select. Empty = don't filter. Case-insensitive match
  // against the parent document's tags OR the chunk's own tags.
  const [selectedTags, setSelectedTags] = useStoreField(queryTabStore, "selectedTags");
  // v0.9.29: Tenant filter UI hidden. Kept as a constant so the filter
  // payload / hasFilters / Clear-reset shape stays stable. Never set.
  const tenant = "";
  const setTenant = (_: string) => {};
  const [pageViewer, setPageViewer] = useStoreField(queryTabStore, "pageViewer");
  // v0.9.23: Preview pane state. When on, clicking a result shows its page
  // preview in the right column instead of jumping to the modal viewer.
  const [previewOn, setPreviewOn] = useStoreField(queryTabStore, "previewOn");
  // v0.9.31: We store just the selected chunk id in the tab store (so the
  // URL and store stay serializable) and rehydrate the full Result object
  // from the current search response whenever needed.
  const [selectedResultId, setSelectedResultId] = useStoreField(queryTabStore, "selectedResultId");
  // expandedKeys is stored as an array so it stays serializable; the
  // component still consumes a Set for .has() checks.
  const [expandedKeysArr, setExpandedKeysArr] = useStoreField(queryTabStore, "expandedKeys");
  const expandedKeys = useMemo(() => new Set(expandedKeysArr), [expandedKeysArr]);
  const setExpandedKeys = useCallback((updater: Set<string> | ((prev: Set<string>) => Set<string>)) => {
    if (typeof updater === "function") {
      setExpandedKeysArr((prevArr) => Array.from(updater(new Set(prevArr))));
    } else {
      setExpandedKeysArr(Array.from(updater));
    }
  }, [setExpandedKeysArr]);
  // Query string that was actually sent for the currently displayed results.
  // Used to highlight matched terms in the result text.
  const [lastQuery, setLastQuery] = useStoreField(queryTabStore, "lastQuery");
  // Ref to the query input so the "/" keyboard shortcut can focus it.
  const inputRef = useRef<HTMLInputElement>(null);
  // Keyboard-navigation index into the flattened result list.
  const [kbdIdx, setKbdIdx] = useStoreField(queryTabStore, "kbdIdx");
  // v0.9.31: Cached last search response so results survive tab switches.
  const [lastResponse, setLastResponse] = useStoreField(queryTabStore, "lastResponse");

  const mut = useMutation({
    mutationFn: async () => {
      const filters: any = {};
      if (productModel) filters.product_model = [productModel];
      if (docType) filters.document_type = [docType];
      if (firmware) filters.firmware_version = [firmware];
      if (errorCode) filters.error_code = errorCode;
      if (confidentialityMax) filters.confidentiality_max = confidentialityMax;
      if (tenant) filters.tenant = tenant;
      if (selectedTags.length) filters.tags = selectedTags;
      // Match mode:
      //   smart    -> hybrid vector + keyword ranking
      //   phrase   -> wrap the whole unquoted remainder in quotes so every
      //               token must appear verbatim in the excerpt (any existing
      //               user quotes are kept as-is)
      //   semantic -> vector-only, no keyword bonus
      let queryToSend = q;
      let hybrid = true;
      if (matchMode === "phrase") {
        // Only wrap if the query has no explicit quotes already; otherwise
        // trust the user's phrasing to avoid double-quoting nonsense.
        if (!/["“”]/.test(q)) queryToSend = `"${q.trim()}"`;
        hybrid = true;
      } else if (matchMode === "semantic") {
        hybrid = false;
      }
      const res = await apiRequest("POST", "/api/search", {
        query: queryToSend,
        top_k: maxResults,
        hybrid,
        filters,
      });
      return res.json() as Promise<SearchResponse>;
    },
    onSuccess: (data) => {
      // Reset selection state when a new query lands.
      setSelectedResultId(null);
      setExpandedKeys(new Set());
      setKbdIdx(null);
      // v0.9.31: Cache the response so it survives a tab switch. The
      // mutation state is reset on remount, but this cache is not.
      setLastResponse(data);
    },
  });

  // v0.9.31: mut.data is the fresh result of the current mutation; it's
  // undefined after unmount/remount. Fall back to the store-cached
  // response so a user tabbing away and back sees their previous hits.
  const activeResponse = mut.data ?? (lastResponse as SearchResponse | null | undefined);

  const clearFilters = () => {
    setProductModel(""); setDocType(""); setFirmware(""); setErrorCode(""); setConfidentialityMax(""); setTenant(""); setSelectedTags([]);
  };

  // v0.9.31: Mirror the URL-synced subset of state to the hash on every
  // change. The write is debounced inside writeHashQuery so typing in the
  // search input doesn't spam history.
  useEffect(() => {
    // Only touch the URL while the Query tab is actually visible - other
    // tabs would otherwise fight us for the hash's query string.
    if (!window.location.hash.startsWith("#/query")) return;
    const s = queryTabStore.getState();
    writeHashQuery(serializeQueryStateToUrl(s));
  }, [q, matchMode, maxResults, productModel, docType, firmware, errorCode, confidentialityMax, selectedTags, selectedResultId]);
  const hasFilters = productModel || docType || firmware || errorCode || confidentialityMax || tenant || selectedTags.length > 0;

  const submit = useCallback(() => {
    if (q.trim()) {
      setLastQuery(q.trim());
      mut.mutate();
    }
  }, [q, mut]);

  // ---- Intent detection (auto-suggest filters from the query text) ----
  const intents = useMemo(() => detectIntents(q, facets), [q, facets]);

  // ---- Grouped + tiered results ----
  const grouped = useMemo(() => (activeResponse ? groupByParent((activeResponse as SearchResponse).results) : []), [activeResponse]);
  const strongGroups = useMemo(
    () => grouped.filter((g) => confidenceTier(g.bestScore) === "strong"),
    [grouped],
  );
  const alsoGroups = useMemo(
    () => grouped.filter((g) => confidenceTier(g.bestScore) !== "strong"),
    [grouped],
  );

  // ---- Flat list for keyboard navigation ----
  const flatResults = useMemo(() => {
    const out: { group: GroupedResults; result: Result; key: string }[] = [];
    for (const g of grouped) {
      for (const r of g.results) out.push({ group: g, result: r, key: r.chunk.id });
    }
    return out;
  }, [grouped]);

  // v0.9.31: Rehydrate the full selected Result object from the stored
  // chunk id + the active response. When the tab remounts, the store
  // only remembers the id (kept small and URL-safe); this lookup is
  // O(n) but n is at most maxResults (usually 12-40).
  const selectedResult = useMemo<Result | null>(() => {
    if (!selectedResultId) return null;
    const hit = flatResults.find((f) => f.key === selectedResultId);
    return hit ? hit.result : null;
  }, [selectedResultId, flatResults]);
  const setSelectedResult = useCallback((r: Result | null) => {
    setSelectedResultId(r ? r.chunk.id : null);
  }, [setSelectedResultId]);

  const toggleExpand = useCallback((key: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // ---- Keyboard shortcuts ----
  //   /      -> focus the query input
  //   j / k  -> move selection down/up through the flat result list
  //   Enter  -> toggle-expand the selected result
  //   Esc    -> clear selection (or blur input if focused there)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Ignore keystrokes originating inside a text input, textarea, or
      // contenteditable so the shortcuts don't fight with normal typing.
      const target = e.target as HTMLElement | null;
      const inField =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);

      if (e.key === "/" && !inField) {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
        return;
      }
      if (e.key === "Escape") {
        if (inField && target instanceof HTMLInputElement && target === inputRef.current) {
          target.blur();
          return;
        }
        if (!inField) {
          setKbdIdx(null);
          return;
        }
      }
      if (inField) return;
      if (flatResults.length === 0) return;
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        setKbdIdx((prev) => {
          const next = prev == null ? 0 : Math.min(flatResults.length - 1, prev + 1);
          const item = flatResults[next];
          if (item) {
            setSelectedResult(item.result);
            document
              .querySelector(`[data-testid="card-result-${item.key}"]`)
              ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
          }
          return next;
        });
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        setKbdIdx((prev) => {
          const next = prev == null ? 0 : Math.max(0, prev - 1);
          const item = flatResults[next];
          if (item) {
            setSelectedResult(item.result);
            document
              .querySelector(`[data-testid="card-result-${item.key}"]`)
              ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
          }
          return next;
        });
      } else if (e.key === "Enter") {
        if (kbdIdx != null) {
          e.preventDefault();
          const item = flatResults[kbdIdx];
          if (item) toggleExpand(item.key);
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [flatResults, kbdIdx, toggleExpand]);

  // v0.9.31: Scroll-position preservation. On mount, jump to the last
  // saved offset (after paint so the DOM is laid out). On unmount, save
  // the current offset back to the store. window.scrollY is fine because
  // the tab content is the only scrollable container at document level.
  useEffect(() => {
    const saved = queryTabStore.getState().scrollY;
    if (saved > 0) {
      // Two rAF's give the results DOM a real chance to lay out before we
      // try to scroll into it - the very first paint may still show the
      // page hint / loading spinner.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => window.scrollTo(0, saved));
      });
    }
    return () => {
      queryTabStore.setState({ scrollY: window.scrollY });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const gridClass = previewOn
    ? "grid gap-6 lg:grid-cols-[300px_minmax(0,1fr)_360px]"
    : "grid gap-6 lg:grid-cols-[300px_minmax(0,1fr)]";

  return (
    <div className={gridClass}>
      {/* --------- Filters sidebar --------- */}
      <Card className="h-fit">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-2"><FilterIcon className="h-3.5 w-3.5" />Filters</span>
            {hasFilters && (
              <button onClick={clearFilters} className="flex items-center gap-1 text-[11px] font-normal text-muted-foreground hover:text-foreground" data-testid="button-clear-filters">
                <X className="h-3 w-3" />Clear
              </button>
            )}
          </CardTitle>
          <CardDescription className="text-xs">Applied before ranking to narrow the search.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <FilterField label="Product model">
            <Select value={productModel || "__any"} onValueChange={(v) => setProductModel(v === "__any" ? "" : v)}>
              <SelectTrigger data-testid="select-filter-model" className="h-8 text-xs"><SelectValue placeholder="Any" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__any">Any</SelectItem>
                {facets?.product_models.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
              </SelectContent>
            </Select>
          </FilterField>
          {/* v0.9.28: Firmware-version filter removed — it wasn't useful for
              most searches (few docs are tagged with firmware, and techs
              filter by product model instead). State is retained (but not
              exposed) so we can restore the filter later without a data
              migration. */}
          <FilterField label="Document type">
            <Select value={docType || "__any"} onValueChange={(v) => setDocType(v === "__any" ? "" : v)}>
              <SelectTrigger data-testid="select-filter-doctype" className="h-8 text-xs"><SelectValue placeholder="Any" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__any">Any</SelectItem>
                {documentTypes?.types.map((type) => (
                  <SelectItem key={type.key} value={type.key}>
                    <span className="inline-flex items-center gap-2">
                      <DocTypeDot color={type.color} />
                      {type.label}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FilterField>
          {/* v0.9.29: Tenant filter hidden — single-tenant deployment. The
              filter payload and server-side handling remain intact for
              future multi-tenant use; only the UI is removed. */}
          <FilterField label="Show up to">
            <Select value={confidentialityMax || "__any"} onValueChange={(v) => setConfidentialityMax(v === "__any" ? "" : v)}>
              <SelectTrigger data-testid="select-filter-confidentiality" className="h-8 text-xs"><SelectValue placeholder="Any confidentiality" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__any">Any confidentiality</SelectItem>
                <SelectItem value="public">Public only</SelectItem>
                <SelectItem value="internal">Public + internal</SelectItem>
                <SelectItem value="confidential">Up to confidential</SelectItem>
                <SelectItem value="restricted">Everything (incl. restricted)</SelectItem>
              </SelectContent>
            </Select>
          </FilterField>
          {/* v0.9.30: Tags multi-select. Renders chip toggles for every
              known tag from /api/facets so techs can narrow to "the docs I
              actually work with today". OR-semantics: chunks pass if their
              parent doc (or the chunk itself) carries any selected tag. */}
          {(facets?.tags?.length ?? 0) > 0 && (
            <FilterField label={<span>Tags {selectedTags.length > 0 && <span className="text-muted-foreground">({selectedTags.length})</span>}</span>}>
              <div
                className="flex max-h-40 flex-wrap gap-1 overflow-y-auto rounded-md border border-input bg-background p-2"
                data-testid="filter-tags-container"
              >
                {(facets?.tags ?? []).map((t: string) => {
                  const on = selectedTags.includes(t);
                  return (
                    <button
                      key={t}
                      type="button"
                      onClick={() =>
                        setSelectedTags((prev) =>
                          on ? prev.filter((x) => x !== t) : [...prev, t]
                        )
                      }
                      className={
                        "rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors " +
                        (on
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border bg-muted/40 text-muted-foreground hover:bg-muted")
                      }
                      data-testid={`chip-filter-tag-${t}`}
                      aria-pressed={on}
                    >
                      {t}
                    </button>
                  );
                })}
              </div>
            </FilterField>
          )}
          {/* v0.9.28: Standalone "Error code (exact)" input removed. Error
              codes are still detected automatically from the query text and
              exposed as clickable Detected: chips above the results, which
              is what techs actually used the input for. */}
          <div className="pt-3 space-y-4 border-t border-border/60">
            <FilterField label={<span className="flex items-center gap-1">Match mode <MatchModeHelp /></span>}>
              <Select value={matchMode} onValueChange={(v) => setMatchMode(v as MatchMode)}>
                <SelectTrigger data-testid="select-match-mode" className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="smart">
                    <span className="flex items-center gap-2"><Sparkles className="h-3 w-3" />Smart (default)</span>
                  </SelectItem>
                  <SelectItem value="phrase">
                    <span className="flex items-center gap-2"><Target className="h-3 w-3" />Exact phrase</span>
                  </SelectItem>
                  <SelectItem value="semantic">
                    <span className="flex items-center gap-2"><Zap className="h-3 w-3" />Semantic only</span>
                  </SelectItem>
                </SelectContent>
              </Select>
            </FilterField>
            <FilterField label={<span>Max results: <span className="font-medium text-foreground">{maxResults}</span></span>}>
              <Slider
                min={5}
                max={30}
                step={1}
                value={[maxResults]}
                onValueChange={(v) => setMaxResults(v[0])}
                data-testid="slider-max-results"
              />
            </FilterField>
          </div>
        </CardContent>
      </Card>

      {/* --------- Results column --------- */}
      <div className="space-y-4">
        <Card>
          <CardContent className="p-3">
            <div className="flex items-center gap-2">
              <Search className="ml-2 h-4 w-4 text-muted-foreground" />
              <Input
                ref={inputRef}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submit()}
                // v1.0.3: select the whole query on focus so typing a
                // new search overwrites the prior one without needing to
                // clear the field first. Matches the behavior of the
                // "/" keyboard shortcut (focus + select).
                onFocus={(e) => e.currentTarget.select()}
                placeholder='Ask something… wrap terms in "quotes" to require an exact match ( / to focus )'
                className="flex-1 border-0 shadow-none focus-visible:ring-0"
                data-testid="input-query"
              />
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => setPreviewOn((v) => !v)}
                    className={
                      "rounded-md border border-border p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground " +
                      (previewOn ? "bg-secondary text-foreground" : "")
                    }
                    data-testid="button-toggle-preview"
                    aria-label="Toggle preview pane"
                  >
                    {previewOn ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {previewOn ? "Hide preview pane" : "Show preview pane"}
                </TooltipContent>
              </Tooltip>
              <Button onClick={submit} disabled={mut.isPending || !q.trim()} data-testid="button-search">
                {mut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Search"}
              </Button>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {EXAMPLE_QUERIES.map((eq) => (
                <button
                  key={eq}
                  onClick={() => { setQ(eq); setTimeout(submit, 0); }}
                  className="rounded-md border border-border bg-secondary px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
                  data-testid={`chip-example-${eq.slice(0, 8)}`}
                >
                  {eq}
                </button>
              ))}
            </div>
            {/* ---- Intent chips: auto-detected pre-fill suggestions ---- */}
            {q.trim().length > 0 && (intents.errorCodes.length > 0 || intents.productModels.length > 0 || intents.uiPaths.length > 0) && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5" data-testid="intent-chips">
                <span className="text-[10.5px] uppercase tracking-wider text-muted-foreground">Detected:</span>
                {intents.errorCodes.map((code) => (
                  <button
                    key={`err-${code}`}
                    onClick={() => setErrorCode(errorCode === code ? "" : code)}
                    className={
                      "rounded-full border px-2 py-0.5 text-[11px] font-mono transition-colors " +
                      (errorCode === code
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-amber-500/50 text-amber-700 hover:bg-amber-500/10 dark:text-amber-300")
                    }
                    data-testid={`chip-intent-error-${code}`}
                    title={errorCode === code ? "Filter applied — click to remove" : `Filter error code = ${code}`}
                  >
                    ⚠ {code}
                  </button>
                ))}
                {intents.productModels.map((model) => (
                  <button
                    key={`model-${model}`}
                    onClick={() => setProductModel(model)}
                    className={
                      "rounded-full border px-2 py-0.5 text-[11px] transition-colors " +
                      (productModel === model
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-blue-500/50 text-blue-700 hover:bg-blue-500/10 dark:text-blue-300")
                    }
                    data-testid={`chip-intent-model-${model}`}
                    title={productModel === model ? "Filter applied" : `Filter product = ${model}`}
                  >
                    {model}
                  </button>
                ))}
                {intents.uiPaths.map((path) => (
                  <span
                    key={`path-${path}`}
                    className="rounded-full border border-border bg-muted/30 px-2 py-0.5 text-[11px] font-mono text-muted-foreground"
                    data-testid={`chip-intent-path-${path.slice(0, 20)}`}
                    title="UI path detected in query"
                  >
                    ↗ {path}
                  </span>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Result summary bar */}
        {activeResponse && (activeResponse as SearchResponse).results.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span data-testid="text-result-summary" className="flex flex-wrap items-center gap-2">
              <span>
                <span className="text-foreground font-medium">{grouped.length}</span> manual{grouped.length === 1 ? "" : "s"} ·{" "}
                <span className="text-foreground font-medium">{(activeResponse as SearchResponse).results.length}</span> excerpts ·{" "}
                <span className="text-foreground font-medium">{(activeResponse as SearchResponse).total_matched}</span> matched the filter
              </span>
              {(activeResponse as SearchResponse).required_phrases && (activeResponse as SearchResponse).required_phrases!.length > 0 && (
                <span className="flex flex-wrap items-center gap-1">
                  <span>exact phrase required:</span>
                  {(activeResponse as SearchResponse).required_phrases!.map((p) => (
                    <Badge key={p} variant="outline" className="text-[10px]" data-testid={`badge-phrase-${p}`}>“{p}”</Badge>
                  ))}
                </span>
              )}
            </span>
            <span className="font-mono">{matchMode === "smart" ? "smart" : matchMode === "phrase" ? "exact phrase" : "semantic only"}</span>
          </div>
        )}

        {/* Loading state */}
        {mut.isPending && (
          <Card><CardContent className="flex items-center gap-2 py-10 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />Searching…
          </CardContent></Card>
        )}

        {/* Empty state (real one) */}
        {activeResponse && (activeResponse as SearchResponse).results.length === 0 && (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center gap-3 py-12 text-center" data-testid="text-no-results">
              <SearchX className="h-8 w-8 text-muted-foreground" />
              <div className="space-y-1">
                <div className="text-sm font-medium text-foreground">No matches</div>
                <div className="max-w-md text-xs text-muted-foreground">
                  {(activeResponse as SearchResponse).required_phrases && (activeResponse as SearchResponse).required_phrases!.length > 0 ? (
                    <>
                      No excerpt contains the exact phrase{(activeResponse as SearchResponse).required_phrases!.length > 1 ? "s" : ""}{" "}
                      {(activeResponse as SearchResponse).required_phrases!.map((p) => (
                        <span key={p} className="font-medium text-foreground">“{p}” </span>
                      ))}
                      . Try removing the quotes, switching to Smart mode, or loosening the wording.
                    </>
                  ) : hasFilters ? (
                    <>Nothing matched with the current filters. Try clearing one and searching again.</>
                  ) : (
                    <>Try broader wording, a synonym, or an example query below.</>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap justify-center gap-1.5 pt-1">
                {hasFilters && (
                  <Button size="sm" variant="outline" onClick={clearFilters} data-testid="button-empty-clear-filters">
                    Clear all filters
                  </Button>
                )}
                {matchMode === "phrase" && (
                  <Button size="sm" variant="outline" onClick={() => { setMatchMode("smart"); setTimeout(submit, 0); }} data-testid="button-empty-switch-smart">
                    Switch to Smart mode
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Best matches section */}
        {strongGroups.length > 0 && (
          <ResultSection
            heading="Best matches"
            testid="section-strong"
            groups={strongGroups}
            expandedKeys={expandedKeys}
            toggleExpand={toggleExpand}
            selectedResult={selectedResult}
            setSelectedResult={setSelectedResult}
            previewOn={previewOn}
            setPageViewer={setPageViewer}
            lastQuery={lastQuery}
            toast={toast}
          />
        )}

        {/* Also relevant section */}
        {alsoGroups.length > 0 && (
          <ResultSection
            heading="Also relevant"
            testid="section-also"
            groups={alsoGroups}
            expandedKeys={expandedKeys}
            toggleExpand={toggleExpand}
            selectedResult={selectedResult}
            setSelectedResult={setSelectedResult}
            previewOn={previewOn}
            setPageViewer={setPageViewer}
            lastQuery={lastQuery}
            toast={toast}
            faded={strongGroups.length > 0}
          />
        )}

        {/* First-visit hint */}
        {!activeResponse && !mut.isPending && (
          <Card className="border-dashed"><CardContent className="py-10 text-center text-sm text-muted-foreground" data-testid="text-query-hint">
            Type a query above or click an example. Press <kbd className="rounded border border-border bg-muted px-1 font-mono text-[10.5px]">/</kbd> to focus,{" "}
            <kbd className="rounded border border-border bg-muted px-1 font-mono text-[10.5px]">j</kbd>/<kbd className="rounded border border-border bg-muted px-1 font-mono text-[10.5px]">k</kbd> to navigate results, <kbd className="rounded border border-border bg-muted px-1 font-mono text-[10.5px]">Enter</kbd> to expand.
          </CardContent></Card>
        )}
      </div>

      {/* --------- Preview pane (right column) --------- */}
      {previewOn && (
        <div className="lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-hidden">
          <PreviewPane result={selectedResult} onOpenViewer={setPageViewer} />
        </div>
      )}

      {pageViewer && (
        <PageViewerDialog
          open={true}
          onOpenChange={(open) => { if (!open) setPageViewer(null); }}
          documentId={pageViewer.id}
          documentTitle={pageViewer.title}
          documentTitleColor={pageViewer.titleColor}
          initialPage={pageViewer.page}
        />
      )}
    </div>
  );
}

function MatchModeHelp() {
  return (
    <TooltipProvider delayDuration={100}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground"
            aria-label="Match mode help"
            data-testid="tooltip-match-mode"
          >
            <Info className="h-3 w-3" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" className="max-w-[240px] text-[11px] leading-relaxed">
          <p className="mb-1"><span className="font-semibold">Smart</span>: blends meaning + keyword hits. Best default.</p>
          <p className="mb-1"><span className="font-semibold">Exact phrase</span>: every word must appear literally.</p>
          <p><span className="font-semibold">Semantic only</span>: pure meaning match. Good for paraphrased searches.</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function FilterField({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Result section: one heading + a stack of parent-grouped cards.
// ---------------------------------------------------------------------------
function ResultSection(props: {
  heading: string;
  testid: string;
  groups: GroupedResults[];
  expandedKeys: Set<string>;
  toggleExpand: (key: string) => void;
  selectedResult: Result | null;
  setSelectedResult: (r: Result | null) => void;
  previewOn: boolean;
  setPageViewer: (v: { id: string; title: string; titleColor: string | null; page: number } | null) => void;
  lastQuery: string;
  toast: ReturnType<typeof useToast>["toast"];
  faded?: boolean;
}) {
  const { heading, testid, groups, faded } = props;
  return (
    <section className="space-y-2" data-testid={testid}>
      <div className="flex items-center gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{heading}</h2>
        <span className="text-[11px] text-muted-foreground">
          {groups.length} manual{groups.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className={"space-y-3 " + (faded ? "opacity-90" : "")}>
        {groups.map((g) => (
          <GroupCard
            key={g.parentId}
            group={g}
            expandedKeys={props.expandedKeys}
            toggleExpand={props.toggleExpand}
            selectedResult={props.selectedResult}
            setSelectedResult={props.setSelectedResult}
            previewOn={props.previewOn}
            setPageViewer={props.setPageViewer}
            lastQuery={props.lastQuery}
            toast={props.toast}
          />
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// One parent-manual card containing 1..N excerpt rows.
// ---------------------------------------------------------------------------
function GroupCard(props: {
  group: GroupedResults;
  expandedKeys: Set<string>;
  toggleExpand: (key: string) => void;
  selectedResult: Result | null;
  setSelectedResult: (r: Result | null) => void;
  previewOn: boolean;
  setPageViewer: (v: { id: string; title: string; titleColor: string | null; page: number } | null) => void;
  lastQuery: string;
  toast: ReturnType<typeof useToast>["toast"];
}) {
  const { group } = props;
  const tier = confidenceTier(group.bestScore);
  return (
    <Card data-testid={`card-group-${group.parentId}`} className="overflow-hidden">
      <CardHeader className="border-b border-border/60 bg-muted/20 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <CardTitle className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
              <BookOpen className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
              {/* v0.9.30: parent title accent color inline; falls back to
                  the theme foreground when null so "text-foreground" wins. */}
              <Link
                href={`/library/${group.parentId}`}
                className="font-semibold text-foreground hover:underline"
                data-testid={`link-manual-${group.parentId}`}
                style={{ color: group.parentTitleColor ?? undefined }}
              >
                {group.parentTitle}
              </Link>
              <ConfidencePill tier={tier} />
            </CardTitle>
            <CardDescription className="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
              {group.parentModel && <Badge variant="outline" className="text-[10px]">{group.parentModel}</Badge>}
              {group.parentFirmware && <Badge variant="outline" className="font-mono text-[10px]">{group.parentFirmware}</Badge>}
              <span className="text-muted-foreground">{group.results.length} matching excerpt{group.results.length === 1 ? "" : "s"}</span>
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-2 p-3">
        {group.results.map((r) => (
          <ResultRow
            key={r.chunk.id}
            result={r}
            expanded={props.expandedKeys.has(r.chunk.id)}
            onToggle={() => props.toggleExpand(r.chunk.id)}
            selected={props.selectedResult?.chunk.id === r.chunk.id}
            onSelect={() => props.setSelectedResult(r)}
            previewOn={props.previewOn}
            setPageViewer={props.setPageViewer}
            lastQuery={props.lastQuery}
            toast={props.toast}
          />
        ))}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// One collapsible excerpt row inside a group card.
// Collapsed: 1-line snippet with citation + confidence.
// Expanded: full excerpt text with highlighting + action buttons + metadata.
// ---------------------------------------------------------------------------
function ResultRow(props: {
  result: Result;
  expanded: boolean;
  onToggle: () => void;
  selected: boolean;
  onSelect: () => void;
  previewOn: boolean;
  setPageViewer: (v: { id: string; title: string; titleColor: string | null; page: number } | null) => void;
  lastQuery: string;
  toast: ReturnType<typeof useToast>["toast"];
}) {
  const { result: r, expanded } = props;
  const [showJson, setShowJson] = useState(false);
  const pageLabel = formatPages(r.chunk.page_start, r.chunk.page_end);
  const sectionLabel = r.chunk.section_title && r.chunk.section_title !== "Body" ? r.chunk.section_title : null;
  const manualTitle = r.parent?.title ?? "Untitled";
  const citationBits = [manualTitle, sectionLabel, pageLabel].filter(Boolean) as string[];
  const citation = citationBits.join(" — ");
  const tier = confidenceTier(r.score);

  // Compact 1-line snippet for the collapsed state - first ~120 chars of content.
  const firstLine = r.chunk.content.replace(/\s+/g, " ").trim().slice(0, 140);

  const handleCopy = async () => {
    const ok = await copyToClipboard(`${r.chunk.content}\n\n— ${citation}`);
    props.toast({
      title: ok ? "Copied to clipboard" : "Copy failed",
      description: ok ? citation : "Your browser blocked the clipboard write.",
    });
  };
  const handlePrint = () => {
    const ok = printExcerpt({ title: manualTitle, citation, body: r.chunk.content });
    if (!ok) props.toast({ title: "Print blocked", description: "Your browser blocked the print window. Allow pop-ups for this app and try again." });
  };
  const handleViewPage = () => {
    if (props.previewOn) {
      // In preview-pane mode the selection already updates the pane; also
      // give a click hint that we're focusing on this result.
      props.onSelect();
      return;
    }
    if (r.parent && r.chunk.page_start) {
      props.setPageViewer({ id: r.parent.id, title: r.parent.title, titleColor: (r.parent as any)?.title_color ?? null, page: r.chunk.page_start });
    }
  };

  return (
    <div
      className={
        "rounded-md border transition-colors " +
        (props.selected
          ? "border-primary/50 bg-primary/5"
          : "border-border/60 bg-background hover:bg-accent/30")
      }
      data-testid={`card-result-${r.chunk.id}`}
      onClick={props.onSelect}
    >
      {/* Row header - always visible */}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); props.onToggle(); }}
        className="flex w-full items-start gap-2 p-2 text-left"
        data-testid={`button-expand-${r.chunk.id}`}
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-muted-foreground">
            {sectionLabel && <span className="font-medium text-foreground">{sectionLabel}</span>}
            {pageLabel && sectionLabel && <ChevronRight className="h-3 w-3 opacity-60" />}
            {pageLabel && <span className="tabular-nums">{pageLabel}</span>}
            <ConfidencePill tier={tier} compact score={r.score} />
          </div>
          {!expanded && (
            <p
              className="mt-0.5 truncate text-xs text-muted-foreground"
              data-testid={`text-snippet-${r.chunk.id}`}
            >
              <Highlight text={firstLine} query={props.lastQuery} />
              {r.chunk.content.length > 140 && "…"}
            </p>
          )}
        </div>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="border-t border-border/60 p-3" onClick={(e) => e.stopPropagation()}>
          <div className="mb-2 flex flex-wrap items-center justify-end gap-1">
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={handleCopy}
                    className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                    data-testid={`button-copy-${r.chunk.id}`}
                    aria-label="Copy excerpt text"
                  >
                    <Copy className="h-4 w-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">Copy excerpt text</TooltipContent>
              </Tooltip>
              {r.parent && r.chunk.page_start && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={handleViewPage}
                      className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                      data-testid={`button-view-page-${r.chunk.id}`}
                      aria-label={props.previewOn ? "Select for preview" : "View original page"}
                    >
                      <ImageIcon className="h-4 w-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    {props.previewOn ? "Show in preview pane" : "View original page"}
                  </TooltipContent>
                </Tooltip>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={handlePrint}
                    className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                    data-testid={`button-print-${r.chunk.id}`}
                    aria-label="Print excerpt"
                  >
                    <Printer className="h-4 w-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">Print excerpt</TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <button
              onClick={() => setShowJson((v) => !v)}
              className="ml-1 text-[11px] text-muted-foreground hover:text-foreground"
              data-testid={`button-metadata-${r.chunk.id}`}
            >
              {showJson ? "Hide metadata" : "Show metadata"}
            </button>
          </div>
          <p className="whitespace-pre-wrap text-sm leading-relaxed" data-testid={`text-content-${r.chunk.id}`}>
            <Highlight text={r.chunk.content} query={props.lastQuery} />
          </p>
          {(r.chunk.error_codes.length > 0 || r.chunk.ui_paths.length > 0) && (
            <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
              {r.chunk.error_codes.map((c: string) => (
                <Badge key={c} variant="outline" className="font-mono text-[10px]">⚠ {c}</Badge>
              ))}
              {r.chunk.ui_paths.map((p: string) => (
                <Badge key={p} variant="outline" className="text-[10px]">↗ {p}</Badge>
              ))}
            </div>
          )}
          {showJson && <div className="mt-3"><JsonBlock data={r.chunk} /></div>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Confidence pill - Strong / Moderate / Weak.
// Replaces the raw "score 0.573" text which was noisy and non-actionable.
// The compact variant is used inside collapsed rows; the full variant is
// used at the group-card header.
// ---------------------------------------------------------------------------
function ConfidencePill({
  tier,
  compact,
  score,
}: {
  tier: "strong" | "moderate" | "weak";
  compact?: boolean;
  score?: number;
}) {
  const classes = {
    strong: "bg-green-500/15 text-green-800 dark:text-green-300 border-green-500/30",
    moderate: "bg-amber-500/15 text-amber-800 dark:text-amber-300 border-amber-500/30",
    weak: "bg-muted text-muted-foreground border-border",
  }[tier];
  const label = tierLabel(tier);
  const tooltip = score != null ? tierTooltip(tier, score) : label;
  return (
    <span
      className={"inline-flex items-center gap-1 rounded-full border px-1.5 py-0 font-medium " + classes + (compact ? " text-[10px]" : " text-[10.5px]")}
      data-testid={`pill-confidence-${tier}`}
      title={tooltip}
    >
      <span>{label}</span>
      {score != null && (
        <span className="opacity-70 font-mono tabular-nums">{score.toFixed(2)}</span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Right-column preview pane - shows the selected result's original page.
// ---------------------------------------------------------------------------
function PreviewPane({
  result,
  onOpenViewer,
}: {
  result: Result | null;
  onOpenViewer: (v: { id: string; title: string; titleColor: string | null; page: number } | null) => void;
}) {
  if (!result) {
    return (
      <Card className="h-full">
        <CardContent className="flex h-64 flex-col items-center justify-center gap-2 text-center text-xs text-muted-foreground">
          <PanelRightOpen className="h-6 w-6" />
          <div>Select a result to preview its original page here.</div>
        </CardContent>
      </Card>
    );
  }
  const pageStart = result.chunk.page_start;
  const parentId = result.parent?.id;
  const pageLabel = formatPages(result.chunk.page_start, result.chunk.page_end);
  const sectionLabel = result.chunk.section_title && result.chunk.section_title !== "Body" ? result.chunk.section_title : null;
  return (
    <Card className="flex h-full flex-col">
      <CardHeader className="pb-2">
        <CardTitle className="truncate text-xs" title={result.parent?.title}>
          {result.parent?.title ?? "Untitled"}
        </CardTitle>
        <CardDescription className="flex flex-wrap items-center gap-1 text-[11px]">
          {sectionLabel && <span className="font-medium text-foreground">{sectionLabel}</span>}
          {pageLabel && sectionLabel && <ChevronRight className="h-3 w-3 opacity-60" />}
          {pageLabel && <span className="tabular-nums">{pageLabel}</span>}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-2 overflow-hidden">
        {parentId && pageStart ? (
          <>
            <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border bg-muted/20">
              <img
                key={`${parentId}-${pageStart}`}
                src={`/api/documents/${parentId}/pages/${pageStart}.jpg`}
                alt={`Page ${pageStart}`}
                className="w-full"
                loading="lazy"
                data-testid="img-preview-page"
              />
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => onOpenViewer({ id: parentId, title: result.parent!.title, titleColor: (result.parent as any)?.title_color ?? null, page: pageStart })}
              data-testid="button-preview-open-viewer"
              className="w-full"
            >
              Open full page viewer
            </Button>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-center text-xs text-muted-foreground">
            No page render available for this excerpt.
          </div>
        )}
      </CardContent>
    </Card>
  );
}
