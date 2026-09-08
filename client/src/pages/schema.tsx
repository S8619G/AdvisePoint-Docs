import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { UpdateCheckPanel } from "@/components/UpdateCheckPanel";
import { ViewerPrefsPanel } from "@/components/ViewerPrefsPanel";
import { LibraryScanPanel } from "@/components/LibraryScanPanel";
import { DiagnosticsPanel } from "@/components/DiagnosticsPanel";
import { BackupPanel } from "@/components/BackupPanel";
import { DocumentTypeManager } from "@/components/DocumentTypeManager";

const FIELD_GROUPS = [
  {
    name: "Product scope",
    tint: "primary",
    fields: [
      ["product_family", "string", "Acme MFP Series"],
      ["product_model", "string (required)", "TASKalfa 5054ci"],
      ["product_version", "semver", "3.2.0"],
      ["firmware_version", "string", "2FX_S000.006.021"],
      ["platform", "string[]", "windows, macos, embedded"],
      ["region", "string[]", "US, EMEA"],
      ["release_channel", "enum", "ga, beta, preview, eol, lts"],
    ],
  },
  {
    name: "Hierarchy (chunk-only)",
    fields: [
      ["section_path", "string[]", "['Authentication', 'LDAP', 'Binding']"],
      ["section_id", "slug", "sec-auth-ldap-bind"],
      ["heading_level", "1-6", "3"],
      ["page_start / page_end", "int", "59"],
      ["chunk_index", "int", "142"],
    ],
  },
  {
    name: "Document typing",
    fields: [
      ["document_type", "enum", "admin_guide, user_manual, troubleshooting_guide, …"],
      ["audience", "enum[]", "administrator, security_officer, developer, …"],
      ["language", "BCP-47", "en-US"],
      ["content_type (chunk)", "enum", "procedure, code_block, cli_command, warning, …"],
    ],
  },
  {
    name: "Access & lifecycle",
    fields: [
      ["confidentiality", "enum", "public → internal → confidential → restricted"],
      ["allowed_tenants", "string[]", "tenant_acme, tenant_globex"],
      ["lifecycle_status", "enum", "draft, in_review, published, deprecated, archived"],
      ["updated_at", "ISO 8601", "2026-06-18T09:41:00Z"],
    ],
  },
  {
    name: "Provenance",
    fields: [
      ["source_uri", "URI", "s3://docs-lake/mfp/admin-v3.2.0.pdf"],
      ["source_system", "string", "s3, confluence, sharepoint, github"],
      ["file_hash_sha256", "hex(64)", "b1946ac9…"],
      ["ingested_at", "ISO 8601", "2026-08-20T18:22:11Z"],
      ["pipeline_version", "string", "advisepoint-docs-1.0.0"],
    ],
  },
  {
    name: "Extracted entities (chunk-only)",
    fields: [
      ["error_codes", "string[]", "E-1042, ERR-204"],
      ["cli_commands", "string[]", "systemctl restart printd"],
      ["ui_paths", "string[]", "Settings > Security > LDAP"],
      ["tags", "string[]", "ldap, tls, authentication"],
    ],
  },
];

const FILTER_MAP: { field: string; use: string; chroma: string; qdrant: string }[] = [
  { field: "product_model", use: "Scope to a device", chroma: "where: { product_model: { $eq: 'X' } }", qdrant: "FieldCondition(key='product.product_model', match=MatchValue('X'))" },
  { field: "firmware_version", use: "Version pinning", chroma: "where: { firmware_version: { $in: [...] } }", qdrant: "match=MatchAny(any=[...])" },
  { field: "document_type", use: "Prefer admin vs user", chroma: "$in: ['admin_guide', 'security_guide']", qdrant: "MatchAny(any=[...])" },
  { field: "lifecycle_status", use: "Exclude drafts / deprecated", chroma: "$eq: 'published'", qdrant: "MatchValue('published')" },
  { field: "allowed_tenants", use: "Multi-tenant isolation", chroma: "sentinel: '|tenant_acme|'", qdrant: "MatchValue('tenant_acme') (array contains)" },
  { field: "confidentiality", use: "Redact restricted content", chroma: "app-level pre-filter", qdrant: "must_not = restricted" },
  { field: "error_codes", use: "Exact code lookup", chroma: "where_document $contains", qdrant: "MatchValue on keyword-indexed array" },
  { field: "updated_at", use: "Freshness cutoff", chroma: "updated_at_ts $gte epoch", qdrant: "DatetimeRange(gte=...)" },
];

export default function SchemaPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Settings &amp; schema</h1>
        <p className="text-sm text-muted-foreground">
          App version and update checker, plus the metadata schema that gets attached to every parent document and excerpt.
        </p>
      </div>

      <Tabs defaultValue="about" className="space-y-4">
        <TabsList data-testid="tabs-schema">
          <TabsTrigger value="about" data-testid="tab-about">About</TabsTrigger>
          <TabsTrigger value="document-types" data-testid="tab-document-types">Document types</TabsTrigger>
          <TabsTrigger value="fields" data-testid="tab-fields">Fields</TabsTrigger>
          <TabsTrigger value="filters" data-testid="tab-filters">Filter mapping</TabsTrigger>
          <TabsTrigger value="examples" data-testid="tab-examples">Examples</TabsTrigger>
        </TabsList>

        <TabsContent value="about" className="space-y-4">
          <UpdateCheckPanel />
          <ViewerPrefsPanel />
          <LibraryScanPanel />
          <BackupPanel />
          <DiagnosticsPanel />
        </TabsContent>

        <TabsContent value="document-types">
          <DocumentTypeManager />
        </TabsContent>

        <TabsContent value="fields" className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            {FIELD_GROUPS.map((g) => (
              <Card key={g.name}>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm">{g.name}</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <table className="w-full text-xs">
                    <tbody>
                      {g.fields.map(([name, type, example]) => (
                        <tr key={name} className="border-t border-border/60">
                          <td className="w-1/3 px-3 py-2 font-mono text-[11px]">{name}</td>
                          <td className="w-1/4 px-3 py-2 text-muted-foreground">{type}</td>
                          <td className="px-3 py-2 font-mono text-[10.5px] text-muted-foreground">{example}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="filters">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Field → filter mapping</CardTitle>
              <CardDescription className="text-xs">How each metadata field lands in Chroma and Qdrant.</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border bg-muted/40 text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                    <th className="px-3 py-2">Field</th>
                    <th className="px-3 py-2">Use</th>
                    <th className="px-3 py-2">Chroma</th>
                    <th className="px-3 py-2">Qdrant</th>
                  </tr>
                </thead>
                <tbody>
                  {FILTER_MAP.map((r) => (
                    <tr key={r.field} className="border-b border-border/60">
                      <td className="px-3 py-2 font-mono text-[11px]">{r.field}</td>
                      <td className="px-3 py-2 text-muted-foreground">{r.use}</td>
                      <td className="px-3 py-2 font-mono text-[10.5px]">{r.chroma}</td>
                      <td className="px-3 py-2 font-mono text-[10.5px]">{r.qdrant}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="examples" className="space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Parent document (minimal)</CardTitle>
              <CardDescription className="text-xs">One record per source document — excerpts reference it via <code className="font-mono">parent_id</code>.</CardDescription>
            </CardHeader>
            <CardContent>
              <pre className="overflow-auto rounded-md border border-border bg-muted/30 p-3 font-mono text-[11px] leading-relaxed">{PARENT_EXAMPLE}</pre>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Excerpt <span className="font-mono text-[10px] text-muted-foreground">(record_type: chunk)</span></CardTitle>
              <CardDescription className="text-xs">One record per embedded excerpt — most metadata is denormalized from the parent for single-hop filtering.</CardDescription>
            </CardHeader>
            <CardContent>
              <pre className="overflow-auto rounded-md border border-border bg-muted/30 p-3 font-mono text-[11px] leading-relaxed">{CHUNK_EXAMPLE}</pre>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">Query recipe <Badge variant="outline" className="text-[10px]">Qdrant</Badge></CardTitle>
              <CardDescription className="text-xs">"Answer for my device" — always inject the user's product and version scope.</CardDescription>
            </CardHeader>
            <CardContent>
              <pre className="overflow-auto rounded-md border border-border bg-muted/30 p-3 font-mono text-[11px] leading-relaxed">{QDRANT_EXAMPLE}</pre>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

const PARENT_EXAMPLE = `{
  "record_type": "parent_document",
  "id": "doc_9f2b4a10-...",
  "title": "TASKalfa 5054ci Administrator Guide",
  "document_type": "admin_guide",
  "product": {
    "product_model": "TASKalfa 5054ci",
    "product_version": "3.2.0",
    "firmware_version": "2FX_S000.006.021",
    "release_channel": "ga"
  },
  "audience": ["administrator", "security_officer"],
  "lifecycle": { "status": "published", "updated_at": "2026-06-18T09:41:00Z" },
  "access": {
    "confidentiality": "internal",
    "allowed_tenants": ["tenant_acme", "tenant_globex"]
  },
  "provenance": {
    "source_uri": "s3://docs-lake/mfp/admin-v3.2.0.pdf",
    "ingested_at": "2026-08-20T18:22:11Z",
    "pipeline_version": "advisepoint-docs-1.0.0"
  }
}`;

const CHUNK_EXAMPLE = `{
  "record_type": "chunk",
  "id": "chk_7a1e3f22-...",
  "parent_id": "doc_9f2b4a10-...",
  "content": "To bind the device to an LDAP directory, navigate to Command Center RX > ...",
  "content_type": "procedure",
  "hierarchy": {
    "section_path": ["Authentication", "LDAP", "Binding to a Directory"],
    "section_id": "sec-auth-ldap-bind",
    "heading_level": 3,
    "chunk_index": 142
  },
  "product": { "product_model": "TASKalfa 5054ci", "firmware_version": "2FX_S000.006.021" },
  "document_type": "admin_guide",
  "access": { "confidentiality": "internal", "allowed_tenants": ["tenant_acme"] },
  "lifecycle_status": "published",
  "extracted_entities": {
    "error_codes": ["E-1042"],
    "ui_paths": ["Command Center RX > Function Settings > Authentication > LDAP"]
  }
}`;

const QDRANT_EXAMPLE = `qfilter = Filter(
  must=[
    FieldCondition(key="product.product_model",   match=MatchValue(value="TASKalfa 5054ci")),
    FieldCondition(key="product.firmware_version", match=MatchValue(value="2FX_S000.006.021")),
    FieldCondition(key="lifecycle_status",         match=MatchValue(value="published")),
    FieldCondition(key="document_type",            match=MatchAny(any=["admin_guide","security_guide"])),
    FieldCondition(key="access.allowed_tenants",   match=MatchValue(value="tenant_acme")),
    FieldCondition(key="updated_at",               range=DatetimeRange(gte="2024-01-01T00:00:00Z")),
  ],
  must_not=[
    FieldCondition(key="access.confidentiality",   match=MatchValue(value="restricted")),
  ],
  should=[
    FieldCondition(key="content_type",             match=MatchValue(value="procedure")),
  ],
)`;
