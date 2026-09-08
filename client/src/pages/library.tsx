import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useParams, Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Trash2, Boxes, Book, Layers, Copy, Printer, BookOpen, FileText, Pencil, ChevronDown, ChevronUp, ArrowUpDown, Search as SearchIcon, X as XIcon, Loader2, RotateCcw } from "lucide-react";
import { Highlight } from "@/lib/highlight";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { PageViewerDialog } from "@/components/PageViewer";
import { Image as ImageIcon } from "lucide-react";
import { AUDIENCES, CONFIDENTIALITY, LIFECYCLE_STATUS, RELEASE_CHANNELS, releaseChannelLabel } from "@shared/schema";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import { JsonBlock } from "./upload";
import { TagsCombobox } from "@/components/TagsCombobox";
import { ProductModelCombobox, RequiredField } from "@/components/ProductModelCombobox";
import { TitleColorPicker } from "@/components/TitleColorPicker";
import { useDocumentTypes, documentTypeColor } from "@/lib/documentTypes";
import { DocTypeDot } from "@/components/DocTypeDot";
import { useState, useEffect, useRef, useCallback } from "react";
import { useStoreField } from "@/lib/tabStore";
import {
  libraryTabStore,
  updateDocDetail,
  serializeLibraryStateToUrl,
  hydrateLibraryStateFromUrl,
  type SortKey as LibrarySortKey,
} from "@/lib/libraryTabStore";
import { writeHashQuery, readHashQuery } from "@/lib/tabUrlSync";

interface Doc {
  id: string;
  title: string;
  subtitle: string | null;
  document_type: string;
  product_family: string | null;
  product_model: string;
  product_version: string | null;
  firmware_version: string | null;
  release_channel: string | null;
  audience: string[];
  tags: string[];
  allowed_tenants: string[];
  confidentiality: string;
  lifecycle_status: string;
  language: string;
  total_chunks: number;
  total_tokens: number;
  ingested_at: string;
  updated_at: string;
  // v0.9.29: enriched server-side from document_render_status.total
  page_count?: number | null;
  // v0.9.30: optional accent color applied to the rendered document title.
  // Stored as a #RRGGBB hex. null (or absent) = use the default text color.
  title_color?: string | null;
  // v1.0.5: original uploaded file name, needed so PageViewerDialog can
  // route DOCX / TXT / MD to the content viewer instead of the PDF viewer.
  file_name?: string | null;
  // v1.0.6: when the app has retained the raw source file on disk, this
  // holds the lowercase extension ("docx"). NULL for pre-v1.0.6 uploads
  // and for extensions we don't retain (TXT/MD/PDF). The library card
  // reads this to badge legacy DOCX rows with a "Re-upload to view"
  // affordance so users know why the rich viewer isn't available.
  original_ext?: string | null;
}

export default function Library() {
  const params = useParams<{ id?: string }>();
  // v0.9.31 hotfix 2: Record the current Library route on every mount so
  // the top-nav Library link can carry the user back to the same view.
  // Kept in a useEffect (not during render) to satisfy React's rule that
  // renders must be side-effect free.
  useEffect(() => {
    const path = params.id ? `/library/${params.id}` : "/library";
    libraryTabStore.setState({ lastLibraryPath: path });
  }, [params.id]);
  if (params.id) return <DocDetail id={params.id} />;
  return <DocList />;
}

type SortKey = LibrarySortKey;

// v0.9.31: Module-scoped one-shot URL hydration for the library store,
// mirrors the pattern in query.tsx. Runs before the DocList mounts so
// the initial render already reflects the URL params.
let libraryStoreHydratedOnce = false;
function hydrateLibraryStoreFromHashOnce() {
  if (libraryStoreHydratedOnce) return;
  libraryStoreHydratedOnce = true;
  const patch = hydrateLibraryStateFromUrl(readHashQuery());
  if (Object.keys(patch).length) libraryTabStore.setState(patch);
}

function DocList() {
  hydrateLibraryStoreFromHashOnce();
  const { data, isLoading } = useQuery<Doc[]>({ queryKey: ["/api/documents"] });
  const { data: documentTypes } = useDocumentTypes();
  // v0.9.31: Top-level filters/sort live in libraryTabStore so they
  // survive tab switches and are mirrored to the URL.
  const [sortBy, setSortBy] = useStoreField(libraryTabStore, "sortBy");
  // v0.9.30: Expand All / Collapse All broadcasts. Each button click bumps a
  // counter; DocCards subscribe via useEffect and set their own expanded state
  // to true or false. Using a monotonically-increasing tick (instead of a
  // single bool) lets users click "Expand all" again after locally collapsing
  // a few cards and get the expected behavior. `null` means "no broadcast yet
  // this session", so freshly mounted cards keep their default (collapsed).
  //
  // These tick counters stay local: preserving them across tab switches
  // would leak "expand all everything again on remount" which is not what
  // users mean when they say "remember my work".
  const [expandTick, setExpandTick] = useState<number | null>(null);
  const [collapseTick, setCollapseTick] = useState<number | null>(null);
  const [filterType, setFilterType] = useStoreField(libraryTabStore, "filterType");
  const [filterModel, setFilterModel] = useStoreField(libraryTabStore, "filterModel");
  // v0.9.36: Product Family filter, symmetric with Product Model.
  const [filterFamily, setFilterFamily] = useStoreField(libraryTabStore, "filterFamily");

  // v0.9.31: URL sync + scroll preservation.
  useEffect(() => {
    if (!window.location.hash.startsWith("#/library")) return;
    writeHashQuery(serializeLibraryStateToUrl(libraryTabStore.getState()));
  }, [sortBy, filterType, filterModel, filterFamily]);
  useEffect(() => {
    const saved = libraryTabStore.getState().scrollY;
    if (saved > 0) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => window.scrollTo(0, saved));
      });
    }
    return () => {
      libraryTabStore.setState({ scrollY: window.scrollY });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (isLoading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-40 w-full" />)}
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <Card className="border-dashed">
        <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
          <Boxes className="h-8 w-8 text-muted-foreground" />
          <div>
            <p className="font-medium">Library is empty</p>
            <p className="text-sm text-muted-foreground">Upload a document from the Upload tab to get started.</p>
          </div>
          <Link href="/upload">
            <Button variant="default" size="sm">Go to Upload</Button>
          </Link>
        </CardContent>
      </Card>
    );
  }

  // Unique product models from the current library (facet-style; sort/filter follows what's actually there).
  const modelOptions = Array.from(new Set(data.map((d) => d.product_model).filter(Boolean))).sort();
  // v0.9.36: Same for product family. Empty/null families are excluded from
  // the options so the dropdown only offers real values.
  const familyOptions = Array.from(
    new Set(data.map((d) => d.product_family).filter((v): v is string => Boolean(v))),
  ).sort();

  // Filter first (doc type + model + family), then sort.
  const filtered = data.filter((d) => {
    if (filterType !== "__any" && d.document_type !== filterType) return false;
    if (filterModel !== "__any" && d.product_model !== filterModel) return false;
    if (filterFamily !== "__any" && (d.product_family ?? "") !== filterFamily) return false;
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    if (sortBy === "title") return a.title.localeCompare(b.title);
    if (sortBy === "document_type") return a.document_type.localeCompare(b.document_type) || a.title.localeCompare(b.title);
    if (sortBy === "product_model") return a.product_model.localeCompare(b.product_model) || a.title.localeCompare(b.title);
    // v0.9.36: family sort. Docs with no family sort to the top; ties break by title.
    if (sortBy === "product_family") return (a.product_family || "").localeCompare(b.product_family || "") || a.title.localeCompare(b.title);
    // "recent" default: newest ingested_at first (server already returns this order).
    return (b.ingested_at || "").localeCompare(a.ingested_at || "");
  });

  // v0.9.36: whether any sort/filter is off default; used to enable the Reset button.
  const filtersAtDefault =
    sortBy === "recent" &&
    filterType === "__any" &&
    filterModel === "__any" &&
    filterFamily === "__any";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Library</h1>
        <p className="text-sm text-muted-foreground">All uploaded documents. Click a title to browse sections, or the pencil to edit any field.</p>
      </div>

      {/* Sort + filter controls. Small, single-row on desktop, wraps on mobile. */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Sort by</Label>
          <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortKey)}>
            <SelectTrigger data-testid="select-sort-by" className="h-8 w-[180px] text-xs">
              <ArrowUpDown className="mr-1 h-3 w-3" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="recent">Recently added</SelectItem>
              <SelectItem value="title">Title (A–Z)</SelectItem>
              <SelectItem value="document_type">Document type</SelectItem>
              <SelectItem value="product_model">Product model</SelectItem>
              <SelectItem value="product_family">Product family</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Document type</Label>
          <Select value={filterType} onValueChange={setFilterType}>
            <SelectTrigger data-testid="select-filter-type" className="h-8 w-[180px] text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__any">All types</SelectItem>
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
        </div>
        <div className="flex flex-col gap-1">
          <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Product model</Label>
          <Select value={filterModel} onValueChange={setFilterModel}>
            <SelectTrigger data-testid="select-filter-model" className="h-8 w-[180px] text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__any">All models</SelectItem>
              {modelOptions.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        {/* v0.9.36: Product Family filter, symmetric with Product Model. */}
        <div className="flex flex-col gap-1">
          <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Product family</Label>
          <Select value={filterFamily} onValueChange={setFilterFamily}>
            <SelectTrigger data-testid="select-filter-family" className="h-8 w-[180px] text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__any">All families</SelectItem>
              {familyOptions.map((f) => <SelectItem key={f} value={f}>{f}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        {/* v0.9.36: Reset sort/filters back to defaults. Ghost variant so it stays
            quieter than the outlined Expand/Collapse buttons. Disabled when
            everything is already at default so clicking gives visual feedback. */}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 gap-1 px-2 text-xs text-muted-foreground"
          onClick={() => {
            setSortBy("recent");
            setFilterType("__any");
            setFilterModel("__any");
            setFilterFamily("__any");
          }}
          disabled={filtersAtDefault}
          data-testid="button-reset-filters"
          title="Reset sort and filters to defaults"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Reset
        </Button>
        {/* v0.9.30: Expand All / Collapse All broadcast buttons. Only render
            when there's actually something to fold, and put them right before
            the count so they don't push the sort/filter controls around. */}
        {sorted.length > 0 && (
          <div className="ml-auto flex items-end gap-1">
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1 px-2 text-xs"
              onClick={() => setExpandTick((t) => (t ?? 0) + 1)}
              data-testid="button-expand-all"
            >
              <ChevronDown className="h-3.5 w-3.5" />
              Expand all
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1 px-2 text-xs"
              onClick={() => setCollapseTick((t) => (t ?? 0) + 1)}
              data-testid="button-collapse-all"
            >
              <ChevronUp className="h-3.5 w-3.5" />
              Collapse all
            </Button>
          </div>
        )}
        <div className={sorted.length > 0 ? "text-xs text-muted-foreground" : "ml-auto text-xs text-muted-foreground"} data-testid="text-library-count">
          {sorted.length} of {data.length} document{data.length === 1 ? "" : "s"}
        </div>
      </div>

      {sorted.length === 0 ? (
        <Card className="border-dashed"><CardContent className="py-10 text-center text-sm text-muted-foreground" data-testid="text-no-docs">
          No documents match the current filters. <button className="underline" onClick={() => { setFilterType("__any"); setFilterModel("__any"); }}>Clear filters</button>
        </CardContent></Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {sorted.map((d) => (
            <DocCard
              key={d.id}
              doc={d}
              expandTick={expandTick}
              collapseTick={collapseTick}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// Editable form state — mirrors the upload form's fields. All strings; audience/tags/tenants
// are comma-joined for the input and split back on save.
interface EditDraft {
  title: string;
  subtitle: string;
  document_type: string;
  product_family: string;
  product_model: string;
  product_version: string;
  firmware_version: string;
  release_channel: string;
  lifecycle_status: string;
  confidentiality: string;
  audience: string[]; // click-to-toggle chips
  tags: string;       // comma-separated
  allowed_tenants: string; // comma-separated
  // v0.9.30: optional accent color for the rendered title. null = default.
  title_color: string | null;
}

function draftFromDoc(doc: Doc): EditDraft {
  return {
    title: doc.title,
    subtitle: doc.subtitle ?? "",
    document_type: doc.document_type,
    product_family: doc.product_family ?? "",
    product_model: doc.product_model,
    product_version: doc.product_version ?? "",
    firmware_version: doc.firmware_version ?? "",
    release_channel: doc.release_channel ?? "__none",
    lifecycle_status: doc.lifecycle_status,
    confidentiality: doc.confidentiality,
    audience: doc.audience ?? [],
    tags: (doc.tags ?? []).join(", "),
    allowed_tenants: (doc.allowed_tenants ?? []).join(", "),
    title_color: doc.title_color ?? null,
  };
}

// Compare draft to original; return only the changed keys as a patch body.
function diffDraft(draft: EditDraft, doc: Doc): Record<string, any> {
  const patch: Record<string, any> = {};
  const splitCsv = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
  const norm = (s: string) => s.trim();
  if (norm(draft.title) !== doc.title) patch.title = norm(draft.title);
  if (norm(draft.subtitle) !== (doc.subtitle ?? "")) patch.subtitle = norm(draft.subtitle) || null;
  if (draft.document_type !== doc.document_type) patch.document_type = draft.document_type;
  if (norm(draft.product_family) !== (doc.product_family ?? "")) patch.product_family = norm(draft.product_family) || null;
  if (norm(draft.product_model) !== doc.product_model) patch.product_model = norm(draft.product_model);
  if (norm(draft.product_version) !== (doc.product_version ?? "")) patch.product_version = norm(draft.product_version) || null;
  if (norm(draft.firmware_version) !== (doc.firmware_version ?? "")) patch.firmware_version = norm(draft.firmware_version) || null;
  const rc = draft.release_channel === "__none" ? null : draft.release_channel;
  if (rc !== (doc.release_channel ?? null)) patch.release_channel = rc;
  if (draft.lifecycle_status !== doc.lifecycle_status) patch.lifecycle_status = draft.lifecycle_status;
  if (draft.confidentiality !== doc.confidentiality) patch.confidentiality = draft.confidentiality;
  const audA = [...draft.audience].sort().join(",");
  const audB = [...(doc.audience ?? [])].sort().join(",");
  if (audA !== audB) patch.audience = draft.audience;
  const tagsA = splitCsv(draft.tags).sort().join(",");
  const tagsB = [...(doc.tags ?? [])].sort().join(",");
  if (tagsA !== tagsB) patch.tags = splitCsv(draft.tags);
  // v0.9.29: Allowed tenants no longer editable from the UI. Never send a
  // patch — preserves whatever was already stored (empty for single-tenant
  // deployments).

  // v0.9.30: title_color diff. null on both sides = no change; otherwise
  // send the new value (which may itself be null to clear the accent).
  const currentTC = doc.title_color ?? null;
  const draftTC = draft.title_color ?? null;
  if (currentTC !== draftTC) patch.title_color = draftTC;

  return patch;
}

// One document tile. Starts collapsed (title + badges only, uniform compact height).
// Chevron toggles the inline preview; pencil opens the full Edit dialog covering every
// field the upload form has. The whole card is a link to the detail page, but header
// controls stopPropagation so they don't navigate.
function DocCard({
  doc,
  expandTick,
  collapseTick,
}: {
  doc: Doc;
  // v0.9.30: broadcast ticks from the page-level Expand/Collapse all buttons.
  // Each tick change flips this card's `expanded` state accordingly. Null =
  // no broadcast has fired this session, so keep the default.
  expandTick?: number | null;
  collapseTick?: number | null;
}) {
  const { data: documentTypes } = useDocumentTypes();
  const [expanded, setExpanded] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [draft, setDraft] = useState<EditDraft>(() => draftFromDoc(doc));
  const qc = useQueryClient();
  const { toast } = useToast();

  // v0.9.30: subscribe to page-level Expand All / Collapse All ticks. We
  // watch the tick value itself so re-clicking the same button (after some
  // cards were locally toggled) forces every card back to the broadcast
  // state. `null` means the button was never pressed — don't override the
  // initial collapsed default.
  useEffect(() => {
    if (expandTick != null) setExpanded(true);
  }, [expandTick]);
  useEffect(() => {
    if (collapseTick != null) setExpanded(false);
  }, [collapseTick]);

  const save = useMutation({
    mutationFn: async (patch: Record<string, any>) => {
      const res = await apiRequest("PATCH", `/api/documents/${doc.id}`, patch);
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/documents"] });
      qc.invalidateQueries({ queryKey: ["/api/documents", doc.id] });
      toast({ title: "Document updated" });
      setEditOpen(false);
    },
    onError: (e: any) => toast({ title: "Update failed", description: e?.message ?? String(e), variant: "destructive" }),
  });

  const patch = diffDraft(draft, doc);
  const hasChanges = Object.keys(patch).length > 0;

  const toggleAudience = (a: string) => {
    setDraft((d) => ({ ...d, audience: d.audience.includes(a) ? d.audience.filter((x) => x !== a) : [...d.audience, a] }));
  };

  const stop = (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); };

  return (
    <>
      <Link href={`/library/${doc.id}`}>
        {/* v0.9.30 item 10: tighter collapsed card.
            Prior: h-[92px] with px-6 py-3 headers + full-size badges +
            mb-1 spacer between badges and title — typically clipped the
            title after ~35 chars. New: h-[68px] using px-4 py-2, half-
            step badges (px-1.5 py-0 leading-[16px]), and no bottom margin
            between the badge row and the title, which buys ~10 extra title
            characters before line-clamp kicks in.
            User direction: keep badges above the title (not on the right),
            but make them small enough that long titles aren't truncated as
            early. Expanded height is unchanged. */}
        <Card
          className={`hover-elevate cursor-pointer transition-all overflow-hidden ${expanded ? "min-h-[280px]" : "h-[68px]"}`}
          data-testid={`card-doc-${doc.id}`}
        >
          <CardHeader className={`${expanded ? "space-y-2 pb-2 pt-3" : "space-y-0 px-4 pb-1 pt-2"}`}>
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className={`${expanded ? "mb-1" : ""} flex items-center gap-1`}>
                  <Badge
                    variant="secondary"
                    className={`${expanded ? "text-[10px]" : "text-[9px] px-1.5 py-0 leading-[14px]"} inline-flex items-center gap-1`}
                    data-testid={`badge-type-${doc.id}`}
                  >
                    {/* v0.9.36: accent dot for user-customized doc type colors. */}
                    <DocTypeDot color={documentTypeColor(doc.document_type, documentTypes?.types)} />
                    {doc.document_type.replace(/_/g, " ")}
                  </Badge>
                  <Badge
                    variant="outline"
                    className={`${expanded ? "text-[10px]" : "text-[9px] px-1.5 py-0 leading-[14px]"}`}
                  >
                    {doc.lifecycle_status}
                  </Badge>
                  {/* v1.0.6: legacy DOCX badge. A DOCX doc without an
                      original_ext was ingested before v1.0.6 started
                      retaining source files, so the new DocxViewerDialog
                      can't render it richly. The amber pill nudges
                      users toward re-uploading the file so the rich
                      viewer becomes available. */}
                  {(doc.file_name ?? "").toLowerCase().endsWith(".docx") &&
                    !doc.original_ext && (
                      <Badge
                        variant="outline"
                        className={`${expanded ? "text-[10px]" : "text-[9px] px-1.5 py-0 leading-[14px]"} border-amber-400 text-amber-700 bg-amber-50`}
                        title="This DOCX was uploaded before v1.0.6. Re-upload to view the original formatting."
                      >
                        Legacy — re-upload for viewing
                      </Badge>
                    )}
                </div>
                {/* v0.9.30: title accent color. `doc.title_color` is a
                    #RRGGBB hex or null; when null we leave the color
                    unset so the theme default takes over. */}
                <CardTitle
                  className={`text-sm leading-snug ${expanded ? "" : "line-clamp-1"}`}
                  data-testid={`text-title-${doc.id}`}
                  title={doc.title}
                  style={{ color: doc.title_color ?? undefined }}
                >
                  {doc.title}
                </CardTitle>
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                <TooltipProvider delayDuration={200}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-muted-foreground hover:text-foreground"
                        onClick={(e) => { stop(e); setDraft(draftFromDoc(doc)); setEditOpen(true); }}
                        data-testid={`button-rename-${doc.id}`}
                        aria-label="Edit document"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top">Edit document</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-muted-foreground hover:text-foreground"
                        onClick={(e) => { stop(e); setExpanded((v) => !v); }}
                        data-testid={`button-expand-${doc.id}`}
                        aria-label={expanded ? "Collapse" : "Expand"}
                      >
                        {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top">{expanded ? "Show title only" : "Show details"}</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
            </div>
          </CardHeader>
          {expanded && (
            <CardContent className="space-y-2 pt-0 text-xs">
              {doc.subtitle && <p className="text-xs text-muted-foreground line-clamp-2">{doc.subtitle}</p>}
              {/*
                v0.9.29: expanded card now shows a compact 2-column key/value
                grid with the metadata a field tech actually looks at when
                scanning the library. Empty fields hide so sparse metadata
                docs don't leave giant gaps.
                v0.9.21 (retained): batch uploads can leave product_model
                blank on purpose; flag blank models in-place so field techs
                know to fill them.
              */}
              <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                {doc.product_model ? (
                  <MetaRow k="Model" v={doc.product_model} />
                ) : (
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-muted-foreground">Model</span>
                    <span className="text-right text-amber-700 dark:text-amber-400">
                      Not set
                    </span>
                  </div>
                )}
                {doc.product_family && <MetaRow k="Family" v={doc.product_family} />}
                {doc.product_version && <MetaRow k="Version" v={doc.product_version} />}
                {/* v0.9.35: label renamed from "Firmware" to "Revision" — the
                    underlying firmware_version column is retained as internal
                    storage; most documents are not firmware-tied. */}
                {doc.firmware_version && <MetaRow k="Revision" v={doc.firmware_version} mono />}
                {doc.release_channel && <MetaRow k="Channel" v={releaseChannelLabel(doc.release_channel)} />}
                {doc.language && <MetaRow k="Language" v={doc.language} />}
                {doc.audience && doc.audience.length > 0 && (
                  <MetaRow k="Audience" v={doc.audience.join(", ")} />
                )}
                {doc.confidentiality && <MetaRow k="Access" v={doc.confidentiality} />}
                {typeof doc.page_count === "number" && doc.page_count > 0 && (
                  <MetaRow k="Pages" v={`${doc.page_count}`} />
                )}
                {doc.updated_at && (
                  <div
                    className="flex items-baseline justify-between gap-2"
                    title={new Date(doc.updated_at).toISOString()}
                  >
                    <span className="text-muted-foreground">Updated</span>
                    <span className="text-right">{relativeTime(doc.updated_at)}</span>
                  </div>
                )}
              </div>
              {doc.tags && doc.tags.length > 0 && (
                <TagsChipRow tags={doc.tags} />
              )}
            </CardContent>
          )}
        </Card>
      </Link>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>Edit document</DialogTitle>
            <DialogDescription>Change any of the fields you selected at upload time. Only edited fields are saved.</DialogDescription>
          </DialogHeader>

          {/* v0.9.30: field ordering, styling, and control choices mirror the
              Upload metadata form so users don't have to translate between two
              layouts:
                * Product model uses the shared ProductModelCombobox with the
                  red "(Required)" label — the plain Input variant let people
                  paste inconsistent model strings.
                * Optional fields carry the same "Optional" placeholder as
                  Upload.
                * Audience chips use the same padding/color scheme as Upload.
                * Firmware version is no longer forced into monospace — it
                  matches Upload, which stopped doing that in v0.9.24 because
                  techs sometimes paste multi-line notes there.
                * Row grouping matches Upload's Row(2) layout exactly.
              A new Title color picker was added at the end (v0.9.30 item 11).
          */}
          <div className="space-y-4 py-2">
            <EditField label="Title">
              <Input
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                maxLength={200}
                data-testid="input-edit-title"
              />
            </EditField>
            <EditField label="Subtitle">
              <Input
                value={draft.subtitle}
                onChange={(e) => setDraft({ ...draft, subtitle: e.target.value })}
                maxLength={500}
                placeholder="Optional"
                data-testid="input-edit-subtitle"
              />
            </EditField>

            <div className="grid grid-cols-2 gap-3">
              <EditField label="Product family">
                <Input
                  value={draft.product_family}
                  onChange={(e) => setDraft({ ...draft, product_family: e.target.value })}
                  placeholder="Optional"
                  data-testid="input-edit-family"
                />
              </EditField>
              <RequiredField label="Product model">
                <ProductModelCombobox
                  value={draft.product_model}
                  onChange={(v) => setDraft({ ...draft, product_model: v })}
                  testId="combobox-edit-product-model"
                />
              </RequiredField>

              <EditField label="Product version">
                <Input
                  value={draft.product_version}
                  onChange={(e) => setDraft({ ...draft, product_version: e.target.value })}
                  placeholder="Optional"
                  data-testid="input-edit-version"
                />
              </EditField>
              <EditField label="Revision">
                <Input
                  value={draft.firmware_version}
                  onChange={(e) => setDraft({ ...draft, firmware_version: e.target.value })}
                  placeholder="Optional"
                  data-testid="input-edit-firmware"
                />
              </EditField>

              <EditField label="Release channel">
                <Select
                  value={draft.release_channel}
                  onValueChange={(v) => setDraft({ ...draft, release_channel: v })}
                >
                  <SelectTrigger data-testid="select-edit-channel">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">None</SelectItem>
                    {RELEASE_CHANNELS.map((r) => (
                      <SelectItem key={r} value={r}>{releaseChannelLabel(r)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </EditField>
              <EditField label="Confidentiality">
                <Select
                  value={draft.confidentiality}
                  onValueChange={(v) => setDraft({ ...draft, confidentiality: v })}
                >
                  <SelectTrigger data-testid="select-edit-confidentiality">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CONFIDENTIALITY.map((c) => (
                      <SelectItem key={c} value={c}>{c}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </EditField>

              <EditField label="Document type">
                <Select
                  value={draft.document_type}
                  onValueChange={(v) => setDraft({ ...draft, document_type: v })}
                >
                  <SelectTrigger data-testid="select-edit-doctype">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
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
              </EditField>
              <EditField label="Lifecycle status">
                <Select
                  value={draft.lifecycle_status}
                  onValueChange={(v) => setDraft({ ...draft, lifecycle_status: v })}
                >
                  <SelectTrigger data-testid="select-edit-lifecycle">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LIFECYCLE_STATUS.map((l) => (
                      <SelectItem key={l} value={l}>{l.replace(/_/g, " ")}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </EditField>
            </div>

            <EditField label="Audience (click to toggle)">
              <div className="flex flex-wrap gap-1.5">
                {AUDIENCES.map((a) => {
                  const on = draft.audience.includes(a);
                  return (
                    <button
                      key={a}
                      type="button"
                      onClick={() => toggleAudience(a)}
                      className={
                        "rounded-md border px-2 py-1 text-xs transition-colors " +
                        (on
                          ? "border-primary/40 bg-primary/10 text-foreground"
                          : "border-border bg-secondary text-muted-foreground hover:text-foreground")
                      }
                      data-testid={`chip-audience-${a}`}
                    >
                      {a.replace(/_/g, " ")}
                    </button>
                  );
                })}
              </div>
            </EditField>

            {/* v0.9.29: Tags is a chip combobox with global autocomplete
                (see components/TagsCombobox). Allowed tenants input removed
                — single-tenant deployment; DB column + Zod schema still
                support it for future multi-tenant use. */}
            <EditField label="Tags">
              <TagsCombobox
                value={draft.tags}
                onChange={(next) => setDraft({ ...draft, tags: next })}
                testId="input-edit-tags"
              />
            </EditField>

            {/* v0.9.30: title color — optional accent for the rendered title.
                Applied everywhere the title is shown (card, detail, page
                viewer, query results, upload results). */}
            <EditField label="Title color">
              <TitleColorPicker
                value={draft.title_color}
                onChange={(next) => setDraft({ ...draft, title_color: next })}
                testId="edit-title-color"
              />
            </EditField>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)} data-testid="button-edit-cancel">Cancel</Button>
            <Button
              onClick={() => save.mutate(patch)}
              disabled={!hasChanges || !draft.title.trim() || !draft.product_model.trim() || save.isPending}
              data-testid="button-edit-save"
            >
              {save.isPending ? "Saving…" : hasChanges ? `Save ${Object.keys(patch).length} change${Object.keys(patch).length === 1 ? "" : "s"}` : "No changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// Small wrapper used only inside the Edit dialog. Renders a label above its input.
function EditField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

function MetaRow({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-muted-foreground">{k}</span>
      <span className={mono ? "font-mono text-[10px]" : "text-right"}>{v}</span>
    </div>
  );
}

// v0.9.29: relative-time helper for the expanded-card "Updated" field. Tries
// to feel natural ("just now", "3d ago", "2mo ago") without dragging in a
// full i18n library. Anything older than a year drops back to an ISO date.
function relativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const diff = Date.now() - t;
  const s = Math.round(diff / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return new Date(t).toISOString().slice(0, 10);
}

// v0.9.29: tag chip row for the expanded Library card. Wraps to 2 lines
// worth of chips then shows a "+N more" pill. Kept intentionally cheap —
// truncation is a fixed count, not a measured layout pass.
function TagsChipRow({ tags }: { tags: string[] }) {
  const MAX = 5;
  const shown = tags.slice(0, MAX);
  const rest = tags.length - shown.length;
  return (
    <div className="flex flex-wrap items-center gap-1 pt-0.5" title={tags.join(", ")}>
      <span className="text-muted-foreground">Tags</span>
      {shown.map((t) => (
        <Badge key={t} variant="secondary" className="rounded-md px-1.5 py-0 text-[10px] font-medium">
          {t}
        </Badge>
      ))}
      {rest > 0 && (
        <Badge variant="outline" className="rounded-md px-1.5 py-0 text-[10px] font-medium">
          +{rest} more
        </Badge>
      )}
    </div>
  );
}

// Groups a document's excerpts by section_title. Preserves original ordering.
// Excerpts with no section (or the placeholder "Body") are bucketed as "Front matter".
function groupSections(chunks: any[]): Array<{
  key: string;
  title: string;
  page_start: number | null;
  page_end: number | null;
  chunks: any[];
  first_index: number;
}> {
  const out: Array<{ key: string; title: string; page_start: number | null; page_end: number | null; chunks: any[]; first_index: number }> = [];
  let current: (typeof out)[number] | null = null;
  const isEmpty = (t: string | null | undefined) => !t || t === "Body";
  for (const c of chunks) {
    const raw = c.section_title as string | null;
    const title = isEmpty(raw) ? "Front matter" : (raw as string);
    // Start a new group whenever the section title changes.
    if (!current || current.title !== title) {
      current = {
        key: `${title}::${c.chunk_index}`,
        title,
        page_start: c.page_start ?? null,
        page_end: c.page_end ?? c.page_start ?? null,
        chunks: [c],
        first_index: c.chunk_index,
      };
      out.push(current);
    } else {
      current.chunks.push(c);
      if (c.page_end != null) current.page_end = Math.max(current.page_end ?? 0, c.page_end);
      else if (c.page_start != null) current.page_end = Math.max(current.page_end ?? 0, c.page_start);
      if (c.page_start != null && current.page_start == null) current.page_start = c.page_start;
    }
  }
  return out;
}

function sectionPageLabel(s: { page_start: number | null; page_end: number | null }): string | null {
  if (s.page_start && s.page_end && s.page_start !== s.page_end) return `pages ${s.page_start}–${s.page_end}`;
  if (s.page_start) return `page ${s.page_start}`;
  if (s.page_end) return `page ${s.page_end}`;
  return null;
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.top = "-9999px";
    document.body.appendChild(ta); ta.focus(); ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}

function printText(opts: { title: string; citation: string; body: string }) {
  const w = window.open("", "_blank", "width=800,height=900");
  if (!w) return false;
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  w.document.write(`<!doctype html><html><head><meta charset="utf-8" /><title>${esc(opts.title)}</title><style>body{font:14px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#111;padding:40px;max-width:780px;margin:auto}h1{font-size:16px;margin:0 0 4px}.cite{color:#555;font-size:12px;margin-bottom:24px;padding-bottom:12px;border-bottom:1px solid #ddd}pre{white-space:pre-wrap;font:inherit;margin:0}@media print{body{padding:0}}</style></head><body><h1>${esc(opts.title)}</h1><div class="cite">${esc(opts.citation)}</div><pre>${esc(opts.body)}</pre><script>window.addEventListener('load',()=>{window.focus();window.print();});</script></body></html>`);
  w.document.close();
  return true;
}

// -------- v0.9.19: In-document search on the library detail page --------
//
// Sits above the sections/excerpts grid and lets a tech search *inside* one
// document without opening the page viewer. Reuses /api/search with the
// document_id filter, so results share the exact tokenization + scoring the
// main Query page and PageViewer's Ctrl+F panel use.
//
// Each row shows a highlighted excerpt plus an "Open page" button; clicking
// the excerpt jumps the sections list to the containing section, clicking
// "Open page" launches the PageViewerDialog at the excerpt's page.
type DocSearchChunk = {
  id: string;
  content: string;
  section_title?: string | null;
  page_start?: number | null;
  page_end?: number | null;
};
type DocSearchResult = { score: number; chunk: DocSearchChunk };

function resultPageLabel(r: DocSearchChunk): string {
  if (r.page_start && r.page_end && r.page_end !== r.page_start) return `pp. ${r.page_start}–${r.page_end}`;
  if (r.page_start) return `p. ${r.page_start}`;
  return "—";
}

// Build a short excerpt window around the first term match so long chunks don't
// dominate the results list. Falls back to the first ~220 chars when no term is
// found (e.g. a scoring hit via TF-IDF on an inflected form).
function excerptAround(content: string, query: string, width = 220): string {
  const clean = content.replace(/\s+/g, " ").trim();
  if (!query) return clean.slice(0, width);
  const terms = query
    .toLowerCase()
    .replace(/["\u201C\u201D]/g, " ")
    .split(/[^a-z0-9._-]+/)
    .filter((t) => t.length >= 2);
  const hay = clean.toLowerCase();
  let hitIdx = -1;
  for (const t of terms) {
    const i = hay.indexOf(t);
    if (i >= 0 && (hitIdx < 0 || i < hitIdx)) hitIdx = i;
  }
  if (hitIdx < 0) return clean.slice(0, width) + (clean.length > width ? "…" : "");
  const start = Math.max(0, hitIdx - Math.floor(width / 3));
  const end = Math.min(clean.length, start + width);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < clean.length ? "…" : "";
  return prefix + clean.slice(start, end) + suffix;
}

function DocSearchBar({
  documentId,
  onJumpToChunk,
  onOpenPage,
  onQueryChange,
}: {
  documentId: string;
  onJumpToChunk: (chunkId: string) => void;
  onOpenPage: (page: number) => void;
  // v0.9.28: DocDetail listens so it can pipe the same query into the
  // section body's <Highlight> so hits are visible after a jump, not just
  // inside the results-panel excerpt.
  onQueryChange?: (query: string) => void;
}) {
  const [input, setInput] = useState("");
  const [debounced, setDebounced] = useState("");
  const [results, setResults] = useState<DocSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset all state whenever the user opens a different doc so we don't leak
  // one document's hits into another's UI.
  useEffect(() => {
    setInput("");
    setDebounced("");
    setResults([]);
    setError(null);
  }, [documentId]);

  // Debounce the fetch to 200ms so per-keystroke typing doesn't hammer the API.
  useEffect(() => {
    const h = window.setTimeout(() => setDebounced(input.trim()), 200);
    return () => window.clearTimeout(h);
  }, [input]);

  // v0.9.28: relay the debounced query up so DocDetail can pass it into
  // the section body renderer for highlighting.
  useEffect(() => {
    onQueryChange?.(debounced);
  }, [debounced, onQueryChange]);

  useEffect(() => {
    if (!debounced) {
      setResults([]);
      setError(null);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    setError(null);
    (async () => {
      try {
        const res = await apiRequest("POST", "/api/search", {
          query: debounced,
          top_k: 25,
          hybrid: true,
          filters: { document_id: documentId },
        });
        const body = await res.json();
        if (cancelled) return;
        setResults(Array.isArray(body?.results) ? body.results : []);
      } catch (e: any) {
        if (cancelled) return;
        setError(String(e?.message ?? e));
        setResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    })();
    return () => { cancelled = true; };
  }, [debounced, documentId]);

  return (
    <div className="space-y-2" data-testid="doc-search-bar">
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Search inside this document… (wrap terms in &quot;quotes&quot; for exact match)"
          className="pl-8 pr-8"
          data-testid="input-doc-search"
          aria-label="Search inside this document"
        />
        {input && (
          <button
            onClick={() => setInput("")}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
            aria-label="Clear search"
            data-testid="button-doc-search-clear"
          >
            <XIcon className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {debounced && (
        <div className="rounded-md border border-border bg-muted/20" data-testid="doc-search-results">
          <div className="flex items-center justify-between px-3 py-2 text-[11px] text-muted-foreground">
            <span>
              {searching ? (
                <span className="inline-flex items-center gap-1.5"><Loader2 className="h-3 w-3 animate-spin" />Searching…</span>
              ) : error ? (
                <span className="text-destructive">Search failed: {error}</span>
              ) : (
                <span data-testid="text-doc-search-count">
                  {results.length === 0
                    ? `No matches for “${debounced}”`
                    : `${results.length} match${results.length === 1 ? "" : "es"} for “${debounced}”`}
                </span>
              )}
            </span>
            <span className="text-[10px]">Uses the same relevance ranking as the Query page.</span>
          </div>

          {!searching && results.length > 0 && (
            <ul className="max-h-[380px] divide-y divide-border overflow-auto">
              {results.map((r, i) => {
                const excerpt = excerptAround(r.chunk.content, debounced);
                const section = r.chunk.section_title && r.chunk.section_title !== "Body"
                  ? r.chunk.section_title
                  : "Front matter";
                const page = r.chunk.page_start ?? null;
                return (
                  <li key={r.chunk.id ?? i} className="px-3 py-2" data-testid={`doc-search-result-${i}`}>
                    <div className="flex items-start justify-between gap-2">
                      <button
                        onClick={() => onJumpToChunk(r.chunk.id)}
                        className="min-w-0 flex-1 text-left"
                        data-testid={`button-doc-search-jump-${i}`}
                        title="Jump to this section in the list below"
                      >
                        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                          <span className="font-mono tabular-nums">{resultPageLabel(r.chunk)}</span>
                          <span className="truncate">{section}</span>
                        </div>
                        <p className="mt-0.5 text-xs leading-snug text-foreground">
                          <Highlight text={excerpt} query={debounced} />
                        </p>
                      </button>
                      {page != null && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 shrink-0 gap-1 text-[10px]"
                          onClick={() => onOpenPage(page)}
                          data-testid={`button-doc-search-openpage-${i}`}
                        >
                          <ImageIcon className="h-3 w-3" />Open page
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function DocDetail({ id }: { id: string }) {
  const { data, isLoading } = useQuery<{ document: Doc; chunks: any[] }>({ queryKey: ["/api/documents", id] });
  const qc = useQueryClient();
  const { toast } = useToast();
  // v0.9.36: pull the doc-type registry so we can render the accent dot
  // next to the document_type badge in the detail header.
  const { data: documentTypes } = useDocumentTypes();
  // v0.9.31: Per-document view state (selected section, view mode,
  // in-document search query, viewer start page) lives in the shared
  // libraryTabStore.docDetail[id] slot so that navigating away to the
  // list and back restores the same context. The store keeps at most 32
  // entries (FIFO) so browsing many docs doesn't grow unboundedly.
  const detail = useStoreField(libraryTabStore, "docDetail")[0][id];
  const selected = detail?.selectedExcerpt ?? 0;
  // v0.9.31 hotfix: setters MUST be stable references. DocSearchBar
  // depends on `onQueryChange` in a useEffect dep list, so a fresh
  // function identity on every render would trigger an infinite
  // update loop (setDocSearchQuery -> store notify -> re-render ->
  // new setter identity -> effect fires again). useCallback keys the
  // setters on the doc id, which is stable for the DocDetail lifetime.
  const setSelected = useCallback((n: number | ((prev: number) => number)) => {
    if (typeof n === "function") {
      const fn = n as (p: number) => number;
      libraryTabStore.setState((prev) => {
        const existing = prev.docDetail[id];
        const prevSel = existing?.selectedExcerpt ?? 0;
        const nextSel = fn(prevSel);
        // Reuse updateDocDetail's merge/cap behavior via an inline patch.
        const rest: typeof prev.docDetail = {};
        for (const [k, v] of Object.entries(prev.docDetail)) if (k !== id) rest[k] = v;
        // If we've seen this doc before, keep its viewMode/search state
        // and only update the selection. Otherwise seed sensible defaults.
        const merged = existing
          ? { ...existing, selectedExcerpt: nextSel }
          : { viewMode: "sections" as const, docSearchQuery: "", selectedExcerpt: nextSel };
        return {
          docDetail: { ...rest, [id]: merged },
        };
      });
    } else {
      updateDocDetail(id, { selectedExcerpt: n });
    }
  }, [id]);
  const viewMode = detail?.viewMode ?? "sections";
  const setViewMode = useCallback((m: "sections" | "excerpts") => {
    updateDocDetail(id, { viewMode: m });
  }, [id]);
  // v0.9.19: refs into the sections list so a DocSearchBar jump can
  // scrollIntoView the target row after we setSelected() on it.
  const sectionButtonRefs = useRef<Record<number, HTMLButtonElement | null>>({});
  // v0.9.28: the current in-document search query, mirrored up from
  // DocSearchBar so <SectionPane> can highlight matching terms in the
  // rendered section body and jump-to-hit can scroll to the first <mark>.
  const docSearchQuery = detail?.docSearchQuery ?? "";
  const setDocSearchQuery = useCallback((q: string) => {
    updateDocDetail(id, { docSearchQuery: q });
  }, [id]);

  const del = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("DELETE", `/api/documents/${id}`);
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/documents"] });
      qc.invalidateQueries({ queryKey: ["/api/stats"] });
      qc.invalidateQueries({ queryKey: ["/api/facets"] });
      toast({ title: "Document deleted" });
      window.location.hash = "/library";
    },
  });

  // Dialog open state stays local - reopening a page viewer just because
  // the tab remounts would surprise the user. But the last requested
  // start page is remembered so "Open page X" then tabbing away and
  // back opens X, not page 1.
  const [pageViewerOpen, setPageViewerOpen] = useState(false);
  // v1.0.1: Delete confirmation dialog state. Kept local (not persisted to
  // the tab store) so navigating away and back doesn't reopen it.
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const pageViewerStart = detail?.pageViewerStart;
  const setPageViewerStart = useCallback((n: number | undefined) => {
    updateDocDetail(id, { pageViewerStart: n });
  }, [id]);

  if (isLoading) return <Skeleton className="h-64 w-full" />;
  if (!data) return <p>Not found.</p>;

  const openPageViewer = (startPage?: number) => {
    setPageViewerStart(startPage);
    setPageViewerOpen(true);
  };

  const chunk = data.chunks[selected];
  const sections = groupSections(data.chunks);
  // Clamp section selection when the section list length changes.
  const safeSectionIdx = Math.min(selected, sections.length - 1);
  const activeSection = sections[safeSectionIdx] ?? sections[0];

  // v0.9.19: given a chunk id from a DocSearchBar hit, find the section it
  // lives in, switch back to Table of Contents view (search from Excerpts view
  // should still land somewhere useful), select the section, and scroll the
  // row into view. Falls back gracefully if the chunk id isn't in any section
  // (shouldn't happen — all chunks belong to the doc — but be defensive).
  const jumpToChunk = (chunkId: string) => {
    const idx = sections.findIndex((s) => s.chunks.some((c: any) => c.id === chunkId));
    if (idx < 0) return;
    setViewMode("sections");
    setSelected(idx);
    // Defer scroll until after the state flush + potential mode-switch remount.
    // v0.9.28: after scrolling the sections list into view, walk the section
    // body scroller down to the first <mark> so the exact hit the results
    // panel is showing lands on screen instead of leaving the reader at the
    // top with the highlighted term potentially well below the fold.
    window.setTimeout(() => {
      const el = sectionButtonRefs.current[idx];
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
      const sectionsCard = document.querySelector('[data-testid="sections-panel"]');
      (sectionsCard as HTMLElement | null)?.scrollIntoView({ block: "start", behavior: "smooth" });
      // Second RAF-ish delay so <SectionPane> has re-rendered with the new
      // section body content before we look for a <mark>. Uses 120ms which
      // covers the section body's own effect that resets scrollTop to 0.
      window.setTimeout(() => {
        const body = document.querySelector('[data-testid="text-section-body"]');
        const firstMark = body?.querySelector('mark') as HTMLElement | null;
        if (firstMark) {
          firstMark.scrollIntoView({ block: "center", behavior: "smooth" });
        }
      }, 200);
    }, 60);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          {/* v0.9.35: enlarged and bolded per BACKLOG. The link was previously
              text-sm/font-semibold and blended into the sub-header rows below;
              text-base/font-bold with a subtle underline on hover gives it
              enough weight to read as a navigation control at a glance. */}
          <Link href="/library" className="text-base font-bold text-foreground hover:text-primary hover:underline underline-offset-4" data-testid="link-back">← Back to library</Link>
          {/* v0.9.30: title accent color — applied at the detail-page
              header the same way it's applied on library cards. */}
          <h1
            className="mt-1 text-xl font-semibold tracking-tight"
            data-testid="text-detail-title"
            style={{ color: data.document.title_color ?? undefined }}
          >
            {data.document.title}
          </h1>
          {data.document.subtitle && <p className="text-sm text-muted-foreground">{data.document.subtitle}</p>}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary" className="text-[10px] inline-flex items-center gap-1">
              <DocTypeDot color={documentTypeColor(data.document.document_type, documentTypes?.types)} />
              {data.document.document_type.replace(/_/g, " ")}
            </Badge>
            <Badge variant="outline" className="text-[10px]">{data.document.product_model}</Badge>
            {data.document.product_version && <Badge variant="outline" className="text-[10px]">v{data.document.product_version}</Badge>}
            {data.document.firmware_version && <Badge variant="outline" className="font-mono text-[10px]">{data.document.firmware_version}</Badge>}
            <Badge variant="outline" className="text-[10px]">{data.document.confidentiality}</Badge>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => openPageViewer(1)} data-testid="button-view-pages">
            <ImageIcon className="mr-2 h-3.5 w-3.5" />View original pages
          </Button>
          {/* v1.0.1: Delete now requires explicit confirmation. Previous
              behavior was one-click destructive with zero warning — a serious
              footgun, especially on trackpads. AlertDialog defaults focus to
              Cancel so Enter is safe. */}
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setDeleteConfirmOpen(true)}
            data-testid="button-delete"
          >
            <Trash2 className="mr-2 h-3.5 w-3.5" />Delete
          </Button>
          <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete this document?</AlertDialogTitle>
                <AlertDialogDescription asChild>
                  <div className="space-y-2">
                    <p>This will permanently remove:</p>
                    <ul className="list-disc pl-5 space-y-1">
                      <li>The document file and its extracted text</li>
                      <li>All rendered pages and thumbnails</li>
                      <li>Search index entries (this document will no longer appear in Query results)</li>
                      <li>Any document-specific settings (Product Model, Document Type, custom metadata)</li>
                    </ul>
                    <p className="font-semibold text-destructive">This action cannot be undone.</p>
                  </div>
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel data-testid="button-delete-cancel">Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  onClick={() => {
                    setDeleteConfirmOpen(false);
                    del.mutate();
                  }}
                  data-testid="button-delete-confirm"
                >
                  Delete document
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {/* v0.9.19: in-document search bar. Renders in both view modes so a tech
          can hop between search hits and the flat excerpt list without losing
          the query. Jump handler flips back to Table of Contents to land in a
          human-readable section. */}
      <DocSearchBar
        documentId={id}
        onJumpToChunk={jumpToChunk}
        onOpenPage={(page) => openPageViewer(page)}
        onQueryChange={setDocSearchQuery}
      />

      {/* View mode toggle */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-1 rounded-md border border-border bg-muted/40 p-0.5 text-xs w-fit">
          <button
            onClick={() => { setViewMode("sections"); setSelected(0); }}
            className={"flex items-center gap-1.5 rounded px-2.5 py-1 transition-colors " + (viewMode === "sections" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
            data-testid="button-view-sections"
            title="Browse the manual by chapter/section, like the printed table of contents."
          ><BookOpen className="h-3.5 w-3.5" />Table of contents <span className="ml-1 text-[10px] font-normal text-muted-foreground">(for reading)</span></button>
          <button
            onClick={() => { setViewMode("excerpts"); setSelected(0); }}
            className={"flex items-center gap-1.5 rounded px-2.5 py-1 transition-colors " + (viewMode === "excerpts" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
            data-testid="button-view-excerpts"
            title="Show every excerpt the search engine indexed. Useful for debugging what a query is drawing from."
          ><FileText className="h-3.5 w-3.5" />Individual excerpts <span className="ml-1 text-[10px] font-normal text-muted-foreground">(for inspection)</span></button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          {viewMode === "sections"
            ? "Grouped by chapter, matching the printed manual. Best for browsing or reading a topic in context."
            : "Flat list of the atomic chunks the search engine indexed. Best for verifying what a query is drawing from."}
        </p>
      </div>

      {viewMode === "sections" ? (
        <div data-testid="sections-panel" className="grid gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Book className="h-3.5 w-3.5" />Sections ({sections.length})
              </CardTitle>
              <CardDescription className="text-[11px]">Click a section to read it. Pages match the printed manual.</CardDescription>
            </CardHeader>
            <CardContent className="max-h-[70vh] space-y-1 overflow-auto p-2">
              {sections.map((s, i) => {
                const pg = sectionPageLabel(s);
                return (
                  <button
                    key={s.key}
                    ref={(el) => { sectionButtonRefs.current[i] = el; }}
                    onClick={() => setSelected(i)}
                    data-testid={`button-section-${i}`}
                    className={
                      "w-full rounded-md border px-2.5 py-2 text-left text-xs transition-colors " +
                      (safeSectionIdx === i ? "border-primary/40 bg-primary/10" : "border-transparent hover:bg-secondary")
                    }
                  >
                    <p className="font-medium leading-snug text-foreground">{s.title}</p>
                    <div className="mt-0.5 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                      <span className="tabular-nums">{pg ?? "—"}</span>
                      <span>{s.chunks.length} excerpt{s.chunks.length === 1 ? "" : "s"}</span>
                    </div>
                  </button>
                );
              })}
            </CardContent>
          </Card>

          {activeSection && (
            <SectionPane
              section={activeSection}
              manualTitle={data.document.title}
              toast={toast}
              sectionIndex={safeSectionIdx}
              sectionTotal={sections.length}
              onPrev={safeSectionIdx > 0 ? () => setSelected(safeSectionIdx - 1) : undefined}
              onNext={safeSectionIdx < sections.length - 1 ? () => setSelected(safeSectionIdx + 1) : undefined}
              onViewPages={activeSection.page_start ? () => openPageViewer(activeSection.page_start!) : undefined}
              highlightQuery={docSearchQuery}
            />
          )}
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm"><Book className="h-3.5 w-3.5" />Excerpts ({data.chunks.length})</CardTitle>
              <CardDescription className="text-[11px]">Raw excerpts for inspection.</CardDescription>
            </CardHeader>
            <CardContent className="max-h-[70vh] space-y-1 overflow-auto p-2">
              {data.chunks.map((c, i) => {
                const sec = c.section_title && c.section_title !== "Body" ? c.section_title : "Front matter";
                const pg = c.page_start ? (c.page_end && c.page_end !== c.page_start ? `pp. ${c.page_start}–${c.page_end}` : `p. ${c.page_start}`) : null;
                return (
                  <button
                    key={c.id}
                    onClick={() => setSelected(i)}
                    data-testid={`button-chunk-${i}`}
                    className={
                      "w-full rounded-md border px-2.5 py-2 text-left text-xs transition-colors " +
                      (selected === i ? "border-primary/40 bg-primary/10" : "border-transparent hover:bg-secondary")
                    }
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono text-[10px] text-muted-foreground">#{i}</span>
                      {pg && <span className="font-mono text-[10px] text-muted-foreground">{pg}</span>}
                    </div>
                    <p className="mt-1 truncate text-[11px]">{sec}</p>
                  </button>
                );
              })}
            </CardContent>
          </Card>

          {chunk && (
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <span className="font-mono text-[11px] text-muted-foreground">Excerpt #{chunk.chunk_index}</span>
                    <Badge variant="secondary" className="text-[10px]">{chunk.content_type}</Badge>
                  </CardTitle>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(JSON.stringify(chunk, null, 2));
                      toast({ title: "Copied JSON" });
                    }}
                    className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
                    data-testid="button-copy-chunk"
                  >
                    <Copy className="h-3 w-3" />Copy JSON
                  </button>
                </div>
                {chunk.section_path.length > 0 && (
                  <CardDescription className="text-[11px]">
                    {chunk.section_path.join(" › ")}
                  </CardDescription>
                )}
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <p className="mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">Content</p>
                  <div className="rounded-md border border-border bg-muted/30 p-3 text-sm leading-relaxed whitespace-pre-wrap" data-testid="text-chunk-content">{chunk.content}</div>
                </div>
                {(chunk.error_codes.length > 0 || chunk.cli_commands.length > 0 || chunk.ui_paths.length > 0) && (
                  <div className="grid gap-3 sm:grid-cols-3">
                    {chunk.error_codes.length > 0 && (
                      <EntityBlock label="Error codes" items={chunk.error_codes} mono />
                    )}
                    {chunk.cli_commands.length > 0 && (
                      <EntityBlock label="CLI" items={chunk.cli_commands} mono />
                    )}
                    {chunk.ui_paths.length > 0 && (
                      <EntityBlock label="UI paths" items={chunk.ui_paths} />
                    )}
                  </div>
                )}
                <div>
                  <p className="mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">Metadata JSON</p>
                  <JsonBlock data={chunk} />
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}
      <PageViewerDialog
        open={pageViewerOpen}
        onOpenChange={setPageViewerOpen}
        documentId={data.document.id}
        documentTitle={data.document.title}
        documentTitleColor={data.document.title_color ?? null}
        initialPage={pageViewerStart}
        // v1.0.5: file name drives PageViewerDialog's PDF-vs-content routing.
        documentFileName={data.document.file_name ?? undefined}
      />
    </div>
  );
}

// Cleans a single chunk's raw text: strips `-- N of TOTAL --` markers, fixes soft-hyphen
// line breaks the extractor leaves behind, and trims stray whitespace at edges.
function cleanChunkText(raw: string): string {
  let t = raw;
  // Remove page markers in all the forms the extractor produces:
  //   "-- 12 of 224 --"  (typical, on its own line)
  //   "12 of 224 --"     (leading dashes lost when chunk started mid-marker)
  //   "-- 12 of 224"     (trailing dashes lost when chunk ended mid-marker)
  t = t.replace(/(?:^|\n)\s*(?:--\s*)?\d+\s+of\s+\d+\s*(?:--)?\s*(?=\n|$)/g, "\n");
  // Also handle mid-line occurrences (rare, but the Doc Box first chunk starts with "18 of 224 -- 4 Document Box").
  t = t.replace(/\b\d+\s+of\s+\d+\s*--\s*/g, "");
  // Rejoin words split with a soft/regular hyphen followed by whitespace: "Certifi‐ cates" -> "Certificates".
  t = t.replace(/([A-Za-z])[\u2010\u2011\u2013\u2014\-]\s+([a-z])/g, "$1$2");
  // Collapse 3+ blank lines to 2.
  t = t.replace(/\n{3,}/g, "\n\n");
  return t.trim();
}

// Whitespace-insensitive overlap detector. Adjacent chunks in this corpus often share a run of
// text where the earlier chunk uses newlines and the later chunk uses spaces (page-break aftermath),
// so we compare on normalized strings and return how many characters of `next` to skip.
function detectOverlap(prev: string, next: string): number {
  // Normalize once: collapse all runs of whitespace to a single space.
  const norm = (s: string) => s.replace(/\s+/g, " ");
  const nPrev = norm(prev);
  const nNext = norm(next);
  const maxWin = Math.min(500, nPrev.length, nNext.length);
  // Require at least ~15 chars of match to avoid false positives on tiny prefixes.
  for (let n = maxWin; n >= 15; n--) {
    if (nPrev.slice(-n) === nNext.slice(0, n)) {
      // Map the matched normalized length back to the raw `next` length.
      // Walk `next` character by character, counting normalized characters until we've consumed `n`.
      let rawIdx = 0;
      let normCount = 0;
      let inWs = false;
      while (rawIdx < next.length && normCount < n) {
        const ch = next[rawIdx];
        if (/\s/.test(ch)) {
          if (!inWs) { normCount += 1; inWs = true; }
        } else {
          normCount += 1;
          inWs = false;
        }
        rawIdx += 1;
      }
      return rawIdx;
    }
  }
  return 0;
}

// Stitches a section's chunks into a single readable string. De-overlaps adjacent chunks and
// inserts a visible page-break separator whenever the starting page advances.
function stitchSection(chunks: any[]): string {
  if (chunks.length === 0) return "";
  const cleaned = chunks.map((c) => ({
    text: cleanChunkText(c.content),
    page_start: (c.page_start as number | null) ?? null,
    page_end: (c.page_end as number | null) ?? null,
  }));
  let out = cleaned[0].text;
  let lastStart = cleaned[0].page_start;
  for (let i = 1; i < cleaned.length; i++) {
    const cur = cleaned[i];
    const overlap = detectOverlap(out, cur.text);
    const trimmed = overlap > 0 ? cur.text.slice(overlap) : cur.text;
    const trimmedClean = trimmed.replace(/^\s+/, "");
    // Compare on the chunk's start page. A gap or advance beyond the previous chunk gets a visible page separator.
    const curStart = cur.page_start;
    const pageBreak = curStart != null && lastStart != null && curStart > lastStart;
    if (pageBreak) {
      out += `\n\n─── page ${curStart} ───\n\n`;
    } else if (overlap === 0) {
      out += "\n\n";
    } else {
      out += trimmedClean.startsWith("\n") ? "" : " ";
    }
    out += trimmedClean;
    if (curStart != null) lastStart = curStart;
  }
  return out;
}

// Right-pane view that shows one whole section as continuous text with citation + Copy/Print.
// Scroll-through navigation: at the bottom of the body, an extra wheel-down (or a small
// downward touch drag) advances to the next section. Same at the top for previous. To
// prevent accidental jumps, the user must accumulate ~120px of over-scroll intent at the
// edge — mirroring the feel of infinite feeds. Explicit Prev/Next buttons are always shown.
function SectionPane({
  section,
  manualTitle,
  toast,
  sectionIndex,
  sectionTotal,
  onPrev,
  onNext,
  onViewPages,
  highlightQuery,
}: {
  section: { title: string; page_start: number | null; page_end: number | null; chunks: any[] };
  manualTitle: string;
  toast: ReturnType<typeof useToast>["toast"] | any;
  sectionIndex: number;
  sectionTotal: number;
  onPrev?: () => void;
  onNext?: () => void;
  onViewPages?: () => void;
  // v0.9.28: raw query string from the in-document search bar. When present,
  // matching terms in the section body are wrapped in <mark> so the user
  // sees the exact text the results panel is drawing from.
  highlightQuery?: string;
}) {
  const pg = sectionPageLabel(section);
  const isFront = section.title === "Front matter";
  const citationBits = [manualTitle, isFront ? null : section.title, pg].filter(Boolean) as string[];
  const citation = citationBits.join(" — ");
  const body = stitchSection(section.chunks);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const overscrollRef = useRef({ down: 0, up: 0, lockedUntil: 0 });
  const OVERSCROLL_THRESHOLD = 120;
  const LOCK_MS = 600;

  // Reset scroll to top whenever the section changes so the reader always starts fresh,
  // and clear any accumulated over-scroll intent from the previous section.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    overscrollRef.current = { down: 0, up: 0, lockedUntil: Date.now() + LOCK_MS };
  }, [sectionIndex]);

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    if (!el) return;
    const now = Date.now();
    if (now < overscrollRef.current.lockedUntil) return;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
    const atTop = el.scrollTop <= 0;
    if (atBottom && e.deltaY > 0 && onNext) {
      overscrollRef.current.down += e.deltaY;
      overscrollRef.current.up = 0;
      if (overscrollRef.current.down >= OVERSCROLL_THRESHOLD) {
        overscrollRef.current.down = 0;
        overscrollRef.current.lockedUntil = now + LOCK_MS;
        onNext();
      }
    } else if (atTop && e.deltaY < 0 && onPrev) {
      overscrollRef.current.up += -e.deltaY;
      overscrollRef.current.down = 0;
      if (overscrollRef.current.up >= OVERSCROLL_THRESHOLD) {
        overscrollRef.current.up = 0;
        overscrollRef.current.lockedUntil = now + LOCK_MS;
        onPrev();
      }
    } else {
      // Mid-scroll — decay accumulators so the user must "hit the edge and keep going".
      overscrollRef.current.down = 0;
      overscrollRef.current.up = 0;
    }
  };

  // Keyboard shortcut: PageDown at bottom jumps to next; PageUp at top jumps to previous.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
    const atTop = el.scrollTop <= 0;
    if (e.key === "PageDown" && atBottom && onNext) { e.preventDefault(); onNext(); }
    else if (e.key === "PageUp" && atTop && onPrev) { e.preventDefault(); onPrev(); }
  };

  const handleCopy = async () => {
    const ok = await copyToClipboard(`${body}\n\n— ${citation}`);
    toast({
      title: ok ? "Copied section to clipboard" : "Copy failed",
      description: ok ? citation : "Your browser blocked the clipboard write.",
    });
  };
  const handlePrint = () => {
    const ok = printText({ title: manualTitle, citation, body });
    if (!ok) toast({ title: "Print blocked", description: "Allow pop-ups for this app and try again." });
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <CardTitle className="text-base leading-snug" data-testid="text-section-title">{section.title}</CardTitle>
            <CardDescription className="mt-1 flex flex-wrap items-center gap-x-1 gap-y-0.5 text-xs">
              <BookOpen className="mr-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="font-medium text-foreground">{manualTitle}</span>
              {pg && <><span className="opacity-50">•</span><span className="tabular-nums">{pg}</span></>}
              <span className="opacity-50">•</span>
              <span>{section.chunks.length} excerpt{section.chunks.length === 1 ? "" : "s"}</span>
            </CardDescription>
          </div>
          <TooltipProvider delayDuration={200}>
            <div className="flex shrink-0 items-center gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button type="button" onClick={handleCopy} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground" data-testid="button-copy-section" aria-label="Copy section text">
                    <Copy className="h-4 w-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">Copy section text</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button type="button" onClick={handlePrint} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground" data-testid="button-print-section" aria-label="Print section">
                    <Printer className="h-4 w-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">Print section</TooltipContent>
              </Tooltip>
              {onViewPages && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button type="button" onClick={onViewPages} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground" data-testid="button-view-section-pages" aria-label="View original pages">
                      <ImageIcon className="h-4 w-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top">View original pages</TooltipContent>
                </Tooltip>
              )}
            </div>
          </TooltipProvider>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div
          ref={scrollRef}
          onWheel={handleWheel}
          onKeyDown={handleKeyDown}
          tabIndex={0}
          className="max-h-[70vh] overflow-auto rounded-md border border-border bg-background p-6 outline-none focus:ring-1 focus:ring-primary/30"
        >
          <div
            className="mx-auto max-w-[68ch] whitespace-pre-wrap text-[13.5px] leading-[1.7] text-foreground"
            data-testid="text-section-body"
          >
            {highlightQuery && highlightQuery.length > 0 ? (
              <Highlight text={body} query={highlightQuery} />
            ) : (
              body
            )}
          </div>
          <div className="mx-auto mt-6 flex max-w-[68ch] items-center justify-between gap-3 border-t border-border/60 pt-4 text-xs text-muted-foreground">
            <button
              type="button"
              onClick={onPrev}
              disabled={!onPrev}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              data-testid="button-section-prev"
            >
              ← Previous section
            </button>
            <span className="tabular-nums">{sectionIndex + 1} / {sectionTotal}</span>
            <button
              type="button"
              onClick={onNext}
              disabled={!onNext}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              data-testid="button-section-next"
            >
              Next section →
            </button>
          </div>
        </div>
        <p className="text-center text-[10px] text-muted-foreground">
          Tip: scroll past the top or bottom to jump between sections — or use PageUp/PageDown.
        </p>
      </CardContent>
    </Card>
  );
}

function EntityBlock({ label, items, mono }: { label: string; items: string[]; mono?: boolean }) {
  return (
    <div>
      <p className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <div className="flex flex-wrap gap-1">
        {items.map((i) => (
          <Badge key={i} variant="outline" className={mono ? "font-mono text-[10px]" : "text-[10px]"}>{i}</Badge>
        ))}
      </div>
    </div>
  );
}
