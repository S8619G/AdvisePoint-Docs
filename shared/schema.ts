import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// ---------- Enums (kept as string unions to stay SQLite-friendly) ----------

// v0.9.23.2: "document" moved to the top of the list and is the new default
// on the Upload page. Prior default was "user_manual", which silently mis-
// tagged non-manual uploads for users who forgot to change it.
export const DOCUMENT_TYPES = [
  "document",
  "brochures",
  "user_manual",
  "admin_guide",
  "installation_guide",
  "quick_start",
  "release_notes",
  "api_reference",
  "troubleshooting_guide",
  "security_guide",
  "procedures",
  "kb_article",
  "bulletin",
  "pricing",
  "misc",
] as const;

export const AUDIENCES = [
  "end_user",
  "administrator",
  "developer",
  "installer",
  "support_engineer",
  "security_officer",
  "field_technician",
] as const;

export const CONFIDENTIALITY = ["public", "internal", "confidential", "restricted"] as const;

export const CONTENT_TYPES = [
  "prose",
  "procedure",
  "code_block",
  "cli_command",
  "config_snippet",
  "table",
  "warning",
  "note",
  "faq",
  "api_endpoint",
] as const;

export const LIFECYCLE_STATUS = ["draft", "in_review", "published", "deprecated", "archived"] as const;

export const RELEASE_CHANNELS = ["ga", "beta", "preview", "eol", "lts"] as const;

// Human-readable labels for release channels.
// v0.9.29: field techs don't always recognize GA/EOL/LTS. Stored value is
// unchanged - only display text differs.
export const RELEASE_CHANNEL_LABELS: Record<(typeof RELEASE_CHANNELS)[number], string> = {
  ga: "General Availability (GA)",
  beta: "Beta",
  preview: "Preview",
  eol: "End of Life (EOL)",
  lts: "Long-Term Support (LTS)",
};

export function releaseChannelLabel(value: string | null | undefined): string {
  if (!value) return "";
  return (RELEASE_CHANNEL_LABELS as Record<string, string>)[value] ?? value.toUpperCase();
}

// ---------- Parent documents ----------

export const documents = sqliteTable("documents", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  subtitle: text("subtitle"),
  document_type: text("document_type").notNull(),
  audience_json: text("audience_json").notNull().default("[]"), // JSON string[]
  language: text("language").notNull().default("en-US"),
  summary: text("summary"),

  // product scope (flattened for filtering)
  product_family: text("product_family"),
  product_model: text("product_model").notNull(),
  product_sku: text("product_sku"),
  product_version: text("product_version"),
  firmware_version: text("firmware_version"),
  platform_json: text("platform_json").notNull().default("[]"),
  region_json: text("region_json").notNull().default("[]"),
  release_channel: text("release_channel"),

  // lifecycle
  lifecycle_status: text("lifecycle_status").notNull().default("published"),
  published_at: text("published_at"),
  updated_at: text("updated_at").notNull(),

  // access
  confidentiality: text("confidentiality").notNull().default("public"),
  allowed_tenants_json: text("allowed_tenants_json").notNull().default("[]"),

  // provenance
  source_uri: text("source_uri"),
  source_system: text("source_system"),
  file_name: text("file_name"),
  file_hash_sha256: text("file_hash_sha256"),
  ingested_at: text("ingested_at").notNull(),
  pipeline_version: text("pipeline_version").notNull().default("advisepoint-docs-1.0.0"),

  tags_json: text("tags_json").notNull().default("[]"),
  keywords_json: text("keywords_json").notNull().default("[]"),

  // v0.9.30: per-document title text color. Nullable = use theme default.
  // Stored as a lowercase hex string like "#0078d4". The Zod schema below
  // enforces the shape; the SQLite column is a plain TEXT so we don't have
  // to CHECK-constrain hex format at the DB layer.
  title_color: text("title_color"),

  // stats
  total_chunks: integer("total_chunks").notNull().default(0),
  total_tokens: integer("total_tokens").notNull().default(0),
});

// ---------- Chunks ----------

export const chunks = sqliteTable("chunks", {
  id: text("id").primaryKey(),
  parent_id: text("parent_id").notNull(),

  content: text("content").notNull(),
  content_type: text("content_type").notNull().default("prose"),
  language: text("language").notNull().default("en-US"),

  // hierarchy (flattened)
  section_path_json: text("section_path_json").notNull().default("[]"),
  section_id: text("section_id"),
  section_title: text("section_title"),
  heading_level: integer("heading_level"),
  page_start: integer("page_start"),
  page_end: integer("page_end"),
  chunk_index: integer("chunk_index").notNull(),

  // denormalized filters from parent
  document_type: text("document_type").notNull(),
  product_model: text("product_model").notNull(),
  product_version: text("product_version"),
  firmware_version: text("firmware_version"),
  audience_json: text("audience_json").notNull().default("[]"),
  confidentiality: text("confidentiality").notNull().default("public"),
  allowed_tenants_json: text("allowed_tenants_json").notNull().default("[]"),
  lifecycle_status: text("lifecycle_status").notNull().default("published"),
  updated_at: text("updated_at").notNull(),

  // extracted signals (comma-joined for LIKE filtering + JSON for display)
  error_codes_json: text("error_codes_json").notNull().default("[]"),
  cli_commands_json: text("cli_commands_json").notNull().default("[]"),
  ui_paths_json: text("ui_paths_json").notNull().default("[]"),
  tags_json: text("tags_json").notNull().default("[]"),

  // "embedding" — a bag-of-terms JSON vector (term -> tf-idf weight)
  // stored as compact JSON string; used for cosine similarity in Node.
  embedding_json: text("embedding_json").notNull().default("{}"),
  token_count: integer("token_count").notNull().default(0),
});

// ---------- Zod schemas ----------

export const insertDocumentSchema = createInsertSchema(documents).omit({
  id: true,
  total_chunks: true,
  total_tokens: true,
  ingested_at: true,
  updated_at: true,
});

export const insertChunkSchema = createInsertSchema(chunks).omit({ id: true });

export type Document = typeof documents.$inferSelect;
export type Chunk = typeof chunks.$inferSelect;
export type InsertDocument = z.infer<typeof insertDocumentSchema>;
export type InsertChunk = z.infer<typeof insertChunkSchema>;

// ---------- API request shapes ----------

export const ingestRequestSchema = z.object({
  title: z.string().min(1),
  subtitle: z.string().optional(),
  document_type: z.string().trim().min(1).max(80),
  audience: z.array(z.enum(AUDIENCES)).default([]),
  language: z.string().default("en-US"),
  summary: z.string().optional(),
  product_family: z.string().optional(),
  // v0.9.21: empty product_model is now allowed on multi-file uploads. The
  // Library tab surfaces "missing product model" as an inline edit call-to-action
  // so the metadata gets filled in after the batch finishes. Older versions of
  // the server required this, so single-file uploads still validate it in the
  // client before sending.
  product_model: z.string().default(""),
  product_sku: z.string().optional(),
  product_version: z.string().optional(),
  firmware_version: z.string().optional(),
  platform: z.array(z.string()).default([]),
  region: z.array(z.string()).default([]),
  release_channel: z.enum(RELEASE_CHANNELS).optional(),
  lifecycle_status: z.enum(LIFECYCLE_STATUS).default("published"),
  confidentiality: z.enum(CONFIDENTIALITY).default("public"),
  allowed_tenants: z.array(z.string()).default([]),
  source_uri: z.string().optional(),
  file_name: z.string().optional(),
  tags: z.array(z.string()).default([]),
  keywords: z.array(z.string()).default([]),
  body: z.string().min(1),
  // chunking options
  chunk_size_tokens: z.number().int().positive().max(2000).default(220),
  chunk_overlap_tokens: z.number().int().min(0).max(500).default(40),
});

export type IngestRequest = z.infer<typeof ingestRequestSchema>;

// PATCH /api/documents/:id — all fields optional; only provided keys are updated.
// Mirrors the ingest form so any field a user can pick at upload time is editable later.
export const documentPatchSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  subtitle: z.string().max(500).nullable().optional(),
  document_type: z.string().trim().min(1).max(80).optional(),
  audience: z.array(z.enum(AUDIENCES)).optional(),
  product_family: z.string().max(200).nullable().optional(),
  // v0.9.21: PATCH stays permissive so users can clear or reset the model
  // via the Library edit dialog after a batch upload.
  product_model: z.string().max(200).optional(),
  product_version: z.string().max(200).nullable().optional(),
  firmware_version: z.string().max(200).nullable().optional(),
  release_channel: z.enum(RELEASE_CHANNELS).nullable().optional(),
  lifecycle_status: z.enum(LIFECYCLE_STATUS).optional(),
  confidentiality: z.enum(CONFIDENTIALITY).optional(),
  allowed_tenants: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  // v0.9.30: per-document title color. Hex like "#0078d4" or null to reset.
  title_color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "must be a 6-digit hex color like #0078d4")
    .nullable()
    .optional(),
});
export type DocumentPatch = z.infer<typeof documentPatchSchema>;

export const searchRequestSchema = z.object({
  query: z.string().min(1),
  top_k: z.number().int().positive().max(50).default(8),
  filters: z
    .object({
      product_model: z.array(z.string()).optional(),
      product_version: z.array(z.string()).optional(),
      firmware_version: z.array(z.string()).optional(),
      document_type: z.array(z.string().trim().min(1).max(80)).optional(),
      audience: z.array(z.enum(AUDIENCES)).optional(),
      content_type: z.array(z.enum(CONTENT_TYPES)).optional(),
      confidentiality_max: z.enum(CONFIDENTIALITY).optional(),
      tenant: z.string().optional(),
      lifecycle_status: z.array(z.enum(LIFECYCLE_STATUS)).optional(),
      error_code: z.string().optional(),
      language: z.string().optional(),
      updated_after: z.string().optional(),
      // v0.9.18: in-document quick search scopes results to one parent doc.
      // Not exposed in the main Query page UI; only used by the viewer's
      // Ctrl+F panel. The chunk column being matched is `parent_id` (which
      // holds the parent document's id).
      document_id: z.string().optional(),
      // v0.9.30: Tags multi-select from the Query page. Matched
      // case-insensitively against both the parent doc's user-supplied tags
      // and each chunk's auto-extracted tags (OR-semantics).
      tags: z.array(z.string()).optional(),
    })
    .default({}),
  hybrid: z.boolean().default(true),
});

export type SearchRequest = z.infer<typeof searchRequestSchema>;
