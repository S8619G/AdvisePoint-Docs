// v1.0.10 - Filename + colored file-type badge for viewer headers.
//
// Every viewer (PDF, DOCX, RTF, TXT, MD) shows the same treatment in its
// metadata row so a user can tell at a glance which file is open and what
// kind of file it is:
//
//   KM-6230-service-manual.pdf  [PDF]
//
// The badge type is derived from the filename extension only (case
// insensitive). Unknown extensions render NO badge -- we deliberately do
// not invent a color for a type we have not designed for.
//
// Palette is locked. Each pair meets WCAG AA against its own background in
// both light and dark mode. Class strings are written out statically so
// Tailwind's scanner sees them; do not build these names dynamically.

export type DocumentFormatCode = "PDF" | "DOCX" | "RTF" | "TXT" | "MD";

const BADGE_CLASSES: Record<DocumentFormatCode, string> = {
  PDF: "text-[#DC2626] bg-[#FEE2E2] dark:text-[#FCA5A5] dark:bg-[rgba(220,38,38,0.15)]",
  DOCX: "text-[#2563EB] bg-[#DBEAFE] dark:text-[#93C5FD] dark:bg-[rgba(37,99,235,0.15)]",
  RTF: "text-[#059669] bg-[#D1FAE5] dark:text-[#6EE7B7] dark:bg-[rgba(5,150,105,0.15)]",
  TXT: "text-[#4B5563] bg-[#E5E7EB] dark:text-[#D1D5DB] dark:bg-[rgba(75,85,99,0.15)]",
  MD: "text-[#7C3AED] bg-[#EDE9FE] dark:text-[#C4B5FD] dark:bg-[rgba(124,58,237,0.15)]",
};

// Extension -> badge code. Only these five map to a badge.
const EXT_TO_CODE: Record<string, DocumentFormatCode> = {
  pdf: "PDF",
  docx: "DOCX",
  rtf: "RTF",
  txt: "TXT",
  md: "MD",
};

/**
 * Resolve the badge code for a filename, or null when the extension is
 * missing or is not one of the five known types.
 */
export function formatCodeForFileName(
  fileName?: string | null,
): DocumentFormatCode | null {
  if (!fileName) return null;
  // Strip any query/fragment noise and take the final dotted segment.
  const base = fileName.split(/[?#]/)[0];
  const dot = base.lastIndexOf(".");
  if (dot === -1 || dot === base.length - 1) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  return EXT_TO_CODE[ext] ?? null;
}

/**
 * The colored type badge on its own. Renders nothing for unknown types.
 */
export function DocumentFormatBadge({
  fileName,
  className,
}: {
  fileName?: string | null;
  className?: string;
}) {
  const code = formatCodeForFileName(fileName);
  if (!code) return null;
  return (
    <span
      data-testid="badge-document-format"
      className={`shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${BADGE_CLASSES[code]}${
        className ? ` ${className}` : ""
      }`}
    >
      {code}
    </span>
  );
}

/**
 * Filename followed by its colored badge -- the standard viewer-header
 * pairing. Renders nothing at all when there is no filename to show, so
 * callers can drop it into a metadata row unconditionally.
 *
 * The filename is shown verbatim (no truncation beyond the `truncate`
 * class), matching how the viewer titles already behave.
 */
export function DocumentFileNameWithBadge({
  fileName,
  className,
}: {
  fileName?: string | null;
  className?: string;
}) {
  if (!fileName) return null;
  return (
    <span
      className={`inline-flex min-w-0 items-center gap-1.5${
        className ? ` ${className}` : ""
      }`}
    >
      <span
        data-testid="text-document-filename"
        className="truncate text-muted-foreground/70"
      >
        {fileName}
      </span>
      <DocumentFormatBadge fileName={fileName} />
    </span>
  );
}
