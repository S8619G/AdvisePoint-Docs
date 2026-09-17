#!/usr/bin/env python3
"""
Render packaging/README.txt into a professionally designed User Guide PDF.

Design system:
  * Serif body (Times) + sans display (Helvetica-Bold) for a manual feel.
  * Consistent 1.0" margins, 11pt body, 1.35 line-height.
  * Chapters open on their own page with numbered heading + rule.
  * Running header shows section title (right) + book title (left).
  * Page number on every body page ("Page N of M").
  * Callout boxes for tips, warnings, and "help" notes.
  * Bulleted lists rendered as real bullets, indented.
  * Fixed-width font for paths and commands, inline.
  * Auto-generated TOC with page numbers via BaseDocTemplate afterFlowable.
  * Glossary and Index sections at the back.
"""

import os
import re
import sys
from datetime import date
from pathlib import Path
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_JUSTIFY
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import inch
from reportlab.pdfgen import canvas
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    Image,
    PageTemplate,
    Paragraph,
    Spacer,
    PageBreak,
    Table,
    TableStyle,
    KeepTogether,
    NextPageTemplate,
    Flowable,
)
from reportlab.platypus.tableofcontents import TableOfContents

# ---------------- Colors ----------------
NAVY = colors.HexColor("#1e3a5f")
NAVY_LIGHT = colors.HexColor("#4a6b8a")
ACCENT = colors.HexColor("#c88a1e")  # warm amber matches app highlight color
RULE = colors.HexColor("#c8cfd6")
TEXT = colors.HexColor("#1a1a1a")
MUTED = colors.HexColor("#5a5a5a")
TIP_BG = colors.HexColor("#f4f7fb")
TIP_BORDER = colors.HexColor("#4a6b8a")
WARN_BG = colors.HexColor("#fdf6ec")
WARN_BORDER = colors.HexColor("#c88a1e")
HELP_BG = colors.HexColor("#eef7f1")
HELP_BORDER = colors.HexColor("#3f8f5f")

# ---------------- Styles ----------------
def make_styles():
    s = {}
    s["cover_title"] = ParagraphStyle(
        "cover_title", fontName="Helvetica-Bold", fontSize=42, leading=48,
        textColor=NAVY, alignment=TA_LEFT, spaceAfter=6,
    )
    s["cover_subtitle"] = ParagraphStyle(
        "cover_subtitle", fontName="Helvetica", fontSize=18, leading=24,
        textColor=NAVY_LIGHT, alignment=TA_LEFT, spaceAfter=6,
    )
    s["cover_meta"] = ParagraphStyle(
        "cover_meta", fontName="Helvetica", fontSize=11, leading=15,
        textColor=MUTED, alignment=TA_LEFT,
    )
    s["h1"] = ParagraphStyle(
        "h1", fontName="Helvetica-Bold", fontSize=22, leading=28,
        textColor=NAVY, spaceBefore=0, spaceAfter=4,
    )
    # h1_notoc: same visual as h1 but a distinct style name, so pages like
    # "Table of Contents" don't register themselves as a TOC entry.
    s["h1_notoc"] = ParagraphStyle(
        "h1_notoc", fontName="Helvetica-Bold", fontSize=22, leading=28,
        textColor=NAVY, spaceBefore=0, spaceAfter=4,
    )
    s["h1_num"] = ParagraphStyle(
        "h1_num", fontName="Helvetica-Bold", fontSize=12, leading=14,
        textColor=ACCENT, spaceBefore=0, spaceAfter=6,
    )
    s["h2"] = ParagraphStyle(
        "h2", fontName="Helvetica-Bold", fontSize=13, leading=17,
        textColor=NAVY, spaceBefore=14, spaceAfter=4,
    )
    s["body"] = ParagraphStyle(
        "body", fontName="Times-Roman", fontSize=11, leading=15,
        textColor=TEXT, alignment=TA_JUSTIFY, spaceAfter=6,
    )
    s["bullet"] = ParagraphStyle(
        "bullet", fontName="Times-Roman", fontSize=11, leading=15,
        textColor=TEXT, leftIndent=18, bulletIndent=6, spaceAfter=3,
    )
    s["sub_bullet"] = ParagraphStyle(
        "sub_bullet", fontName="Times-Roman", fontSize=10.5, leading=14,
        textColor=TEXT, leftIndent=36, bulletIndent=24, spaceAfter=2,
    )
    s["numbered"] = ParagraphStyle(
        "numbered", fontName="Times-Roman", fontSize=11, leading=15,
        textColor=TEXT, leftIndent=22, bulletIndent=4, spaceAfter=4,
    )
    s["code_block"] = ParagraphStyle(
        "code_block", fontName="Courier", fontSize=9.5, leading=13,
        textColor=TEXT, leftIndent=22, backColor=colors.HexColor("#f2f4f7"),
        borderPadding=6, spaceAfter=6,
    )
    s["callout_title"] = ParagraphStyle(
        "callout_title", fontName="Helvetica-Bold", fontSize=10, leading=13,
        textColor=NAVY, spaceAfter=2,
    )
    s["callout_body"] = ParagraphStyle(
        "callout_body", fontName="Times-Roman", fontSize=10, leading=14,
        textColor=TEXT, spaceAfter=0,
    )
    s["toc_h1"] = ParagraphStyle(
        "toc_h1", fontName="Helvetica-Bold", fontSize=11, leading=16,
        textColor=NAVY, leftIndent=0,
    )
    s["toc_h2"] = ParagraphStyle(
        "toc_h2", fontName="Helvetica", fontSize=10, leading=14,
        textColor=TEXT, leftIndent=20,
    )
    s["glossary_term"] = ParagraphStyle(
        "glossary_term", fontName="Helvetica-Bold", fontSize=10.5, leading=14,
        textColor=NAVY, spaceBefore=4, spaceAfter=1,
    )
    s["glossary_def"] = ParagraphStyle(
        "glossary_def", fontName="Times-Roman", fontSize=10.5, leading=14,
        textColor=TEXT, leftIndent=14, spaceAfter=4,
    )
    return s


# ---------------- Custom flowables ----------------

class Callout(Flowable):
    """A colored notice box: title bar + body paragraphs."""
    def __init__(self, kind, title, body_paras, width):
        super().__init__()
        self.kind = kind
        self.title = title
        self.body_paras = body_paras
        self.width = width
        colors_map = {
            "tip":  (TIP_BG,  TIP_BORDER),
            "warn": (WARN_BG, WARN_BORDER),
            "help": (HELP_BG, HELP_BORDER),
        }
        self.bg, self.border = colors_map[kind]

    def wrap(self, availWidth, availHeight):
        self.width = availWidth
        pad = 8
        title_h = 14
        body_h = 0
        for p in self.body_paras:
            w, h = p.wrap(self.width - 2 * pad - 4, availHeight)
            body_h += h + 2
        self.height = title_h + body_h + 2 * pad + 2
        return self.width, self.height

    def draw(self):
        c = self.canv
        pad = 8
        c.saveState()
        # background
        c.setFillColor(self.bg)
        c.setStrokeColor(self.border)
        c.setLineWidth(0.75)
        c.roundRect(0, 0, self.width, self.height, 3, stroke=1, fill=1)
        # left accent bar
        c.setFillColor(self.border)
        c.rect(0, 0, 3, self.height, stroke=0, fill=1)
        # title
        c.setFillColor(self.border)
        c.setFont("Helvetica-Bold", 9.5)
        c.drawString(pad + 4, self.height - pad - 2, self.title.upper())
        # body
        y = self.height - pad - 16
        for p in self.body_paras:
            w, h = p.wrap(self.width - 2 * pad - 4, 10_000)
            p.drawOn(c, pad + 4, y - h)
            y -= h + 2
        c.restoreState()


class HorizontalRule(Flowable):
    def __init__(self, width=None, thickness=0.6, color=RULE, space_before=2, space_after=8):
        super().__init__()
        self.width_hint = width
        self.thickness = thickness
        self.color = color
        self.space_before = space_before
        self.space_after = space_after

    def wrap(self, availWidth, availHeight):
        self.width = self.width_hint or availWidth
        self.height = self.thickness + self.space_before + self.space_after
        return availWidth, self.height

    def draw(self):
        c = self.canv
        c.setStrokeColor(self.color)
        c.setLineWidth(self.thickness)
        y = self.space_after
        c.line(0, y, self.width, y)


# ---------------- Doc template with page numbers, headers, TOC hooks ----------------

BOOK_TITLE = "AdvisePoint Docs"
BOOK_SUBTITLE = "User Guide"

class GuideDocTemplate(BaseDocTemplate):
    """Doc template with cover, front matter, and body page templates."""

    def __init__(self, filename, **kw):
        super().__init__(filename, **kw)
        self.total_pages = 0
        self.current_chapter_title = ""

        frame_body = Frame(
            self.leftMargin, self.bottomMargin,
            self.width, self.height,
            leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0,
            id="body",
        )
        # Cover: the navy band occupies x=0 to x=1.6" and there's a 0.05" amber
        # accent stripe just right of it. Flowables must start at x=2.0" to sit
        # comfortably right of both bands.
        cover_left = 2.0 * inch
        frame_cover = Frame(
            cover_left, self.bottomMargin,
            LETTER[0] - cover_left - self.rightMargin, self.height,
            leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0,
            id="cover",
        )

        self.addPageTemplates([
            PageTemplate(id="cover", frames=[frame_cover], onPage=self._draw_cover_deco),
            PageTemplate(id="front", frames=[frame_body], onPage=self._draw_front_deco),
            # Draw body chrome on page END (after flowables are placed and
            # afterFlowable() has updated current_chapter_title), so the
            # running header reflects the chapter that actually starts on
            # this page — not the previous one.
            PageTemplate(id="body",  frames=[frame_body], onPageEnd=self._draw_body_deco),
        ])

    # ---- decorations ----
    def _draw_cover_deco(self, c, doc):
        # Full-bleed navy band on the left of the cover
        c.saveState()
        c.setFillColor(NAVY)
        c.rect(0, 0, 1.6 * inch, LETTER[1], stroke=0, fill=1)
        # thin accent stripe just right of the navy band
        c.setFillColor(ACCENT)
        c.rect(1.6 * inch, 0, 0.05 * inch, LETTER[1], stroke=0, fill=1)
        # Vertical wordmark down the navy band, so the cover has structure
        # without competing with the title text
        c.saveState()
        c.setFillColor(colors.whitesmoke)
        c.setFont("Helvetica-Bold", 10)
        c.translate(0.6 * inch, 1.0 * inch)
        c.rotate(90)
        c.drawString(0, 0, "USER GUIDE  \u00b7  ADVISEPOINT DOCS")
        c.restoreState()
        # Footer date on the cover, on the white side
        c.setFillColor(MUTED)
        c.setFont("Helvetica", 9)
        c.drawRightString(LETTER[0] - self.rightMargin, self.bottomMargin - 24,
                          f"Revision {doc._revision} \u00b7 {doc._rev_date}")
        c.restoreState()

    def _draw_front_deco(self, c, doc):
        # TOC and other front pages: header rule, small footer, roman numerals
        c.saveState()
        c.setStrokeColor(RULE)
        c.setLineWidth(0.5)
        top_y = LETTER[1] - self.topMargin + 18
        c.line(self.leftMargin, top_y, LETTER[0] - self.rightMargin, top_y)
        c.setFillColor(MUTED)
        c.setFont("Helvetica", 8.5)
        c.drawString(self.leftMargin, top_y + 4, BOOK_TITLE)
        c.drawRightString(LETTER[0] - self.rightMargin, top_y + 4, "Table of Contents")
        # footer roman
        c.setFont("Helvetica", 8.5)
        c.setFillColor(MUTED)
        c.drawCentredString(LETTER[0] / 2, self.bottomMargin - 24, _to_roman(doc.page - 1))
        c.restoreState()

    def _draw_body_deco(self, c, doc):
        c.saveState()
        c.setStrokeColor(RULE)
        c.setLineWidth(0.5)
        top_y = LETTER[1] - self.topMargin + 18
        c.line(self.leftMargin, top_y, LETTER[0] - self.rightMargin, top_y)
        c.setFillColor(MUTED)
        c.setFont("Helvetica", 8.5)
        c.drawString(self.leftMargin, top_y + 4, BOOK_TITLE)
        title = self.current_chapter_title or ""
        c.drawRightString(LETTER[0] - self.rightMargin, top_y + 4, title)
        # footer: revision (left) | page + amber dot (center) | version (right)
        footer_y = self.bottomMargin - 24
        c.setFillColor(MUTED)
        c.setFont("Helvetica", 8)
        c.drawString(self.leftMargin, footer_y,
                     f"Rev. {self._revision} \u00b7 {self._rev_date}")
        c.drawRightString(LETTER[0] - self.rightMargin, footer_y,
                          f"v{self._version}")
        page_str = f"Page {doc.page - self._body_offset} of {self._body_total}"
        c.setFillColor(ACCENT)
        c.circle(LETTER[0] / 2 - 2, footer_y + 3, 1.5, stroke=0, fill=1)
        c.setFillColor(MUTED)
        c.setFont("Helvetica", 8.5)
        c.drawCentredString(LETTER[0] / 2 + 8, footer_y, page_str)
        c.restoreState()

    # ---- TOC integration ----
    def afterFlowable(self, flowable):
        # Register chapter headings with the TOC
        if isinstance(flowable, Paragraph):
            style = flowable.style.name
            text = _plain(flowable.getPlainText())
            if style == "h1":
                self.notify("TOCEntry", (0, text, self.page))
                self.current_chapter_title = text
            elif style == "h2":
                self.notify("TOCEntry", (1, text, self.page))


def _plain(t):
    return re.sub(r"<[^>]+>", "", t)


def _find_cover_logo():
    """Return the path to the largest raster app icon in the repo, or None.

    Prefers apple-touch-icon (180\u00d7180) because it's the biggest raster
    version bundled with the app, so downscaling to ~1.4" stays crisp. Falls
    back to favicon.png if the touch icon is missing.
    """
    here = os.path.dirname(os.path.abspath(__file__))
    repo_root = os.path.dirname(here)  # advisepoint-src/
    candidates = [
        os.path.join(repo_root, "client", "public", "apple-touch-icon.png"),
        os.path.join(repo_root, "client", "public", "favicon.png"),
    ]
    for p in candidates:
        if os.path.isfile(p):
            return p
    return None


def _to_roman(n):
    if n <= 0:
        return ""
    vals = [(1000,"m"),(900,"cm"),(500,"d"),(400,"cd"),(100,"c"),
            (90,"xc"),(50,"l"),(40,"xl"),(10,"x"),(9,"ix"),(5,"v"),(4,"iv"),(1,"i")]
    out = []
    for v, s in vals:
        while n >= v:
            out.append(s); n -= v
    return "".join(out)


# ---------------- Two-pass render (for total page count in footer) ----------------

def render(readme_path: Path, out_path: Path, version: str,
           revision: str, rev_date: str):
    # First pass: compute total body pages
    total_body = _render_pass(readme_path, out_path, version, revision, rev_date,
                              body_total=1, body_offset=0)
    _render_pass(readme_path, out_path, version, revision, rev_date,
                 body_total=total_body["body_pages"],
                 body_offset=total_body["body_offset"])


def _render_pass(readme_path, out_path, version, revision, rev_date, body_total, body_offset):
    styles = make_styles()
    text = readme_path.read_text(encoding="utf-8")

    doc = GuideDocTemplate(
        str(out_path),
        pagesize=LETTER,
        leftMargin=1.0 * inch, rightMargin=1.0 * inch,
        topMargin=1.0 * inch, bottomMargin=1.0 * inch,
        title=f"{BOOK_TITLE} User Guide",
        author="Perplexity Computer",
        subject=f"AdvisePoint Docs v{version} User Guide",
    )
    doc._body_total = body_total
    doc._body_offset = body_offset
    doc._version = version
    doc._revision = revision
    doc._rev_date = rev_date

    story = []

    # -------- Cover page --------
    # The navy band is drawn from x=0 to x=1.6", so cover flowables live in a
    # narrower frame that starts to the right of the band with generous inset.
    # The frame is set up in the cover template.
    story.append(NextPageTemplate("cover"))
    story.append(Spacer(1, 1.4 * inch))

    # App logo above the title. Draw it on a table cell so it left-aligns with
    # the title text (rather than centered in the frame).
    logo_path = _find_cover_logo()
    if logo_path:
        logo = Image(logo_path, width=1.4 * inch, height=1.4 * inch)
        logo.hAlign = "LEFT"
        story.append(logo)
        story.append(Spacer(1, 0.35 * inch))
    else:
        story.append(Spacer(1, 0.4 * inch))

    story.append(Paragraph("AdvisePoint", styles["cover_title"]))
    story.append(Paragraph("Docs", styles["cover_title"]))
    story.append(Spacer(1, 0.2 * inch))
    story.append(Paragraph("User Guide", styles["cover_subtitle"]))
    story.append(Spacer(1, 0.4 * inch))
    story.append(HorizontalRule(width=3.5 * inch, thickness=1, color=ACCENT,
                                space_before=0, space_after=12))
    story.append(Paragraph(f"Application version {version}", styles["cover_meta"]))
    story.append(Paragraph(
        f"Document revision {revision} &nbsp;\u00b7&nbsp; {rev_date}",
        styles["cover_meta"]))
    story.append(Spacer(1, 0.2 * inch))
    story.append(Paragraph("A local search tool for technical manuals and admin guides.",
                           styles["cover_meta"]))
    story.append(Spacer(1, 0.08 * inch))
    story.append(Paragraph("Everything runs on your own laptop. No internet required after install.",
                           styles["cover_meta"]))

    # -------- Table of Contents --------
    story.append(NextPageTemplate("front"))
    story.append(PageBreak())
    story.append(Paragraph("Table of Contents", styles["h1_notoc"]))
    story.append(HorizontalRule(space_after=14))
    toc = TableOfContents()
    # Uniform tab-based dot leader for all TOC levels so entries line up
    # cleanly regardless of title length.
    tab_stops_h1 = [(6.35 * inch, "right", ".")]
    tab_stops_h2 = [(6.35 * inch, "right", ".")]
    toc_h1_style = ParagraphStyle(
        "toc_h1_leader", parent=styles["toc_h1"], tabs=tab_stops_h1,
    )
    toc_h2_style = ParagraphStyle(
        "toc_h2_leader", parent=styles["toc_h2"], tabs=tab_stops_h2,
    )
    toc.levelStyles = [toc_h1_style, toc_h2_style]
    story.append(toc)

    # -------- Body --------
    story.append(NextPageTemplate("body"))
    story.append(PageBreak())

    chapters = _parse_chapters(text)
    # We drop the very first "AdvisePoint Docs" title chapter; it's the cover.
    chapters = [c for c in chapters if c["title"].upper() != "ADVISEPOINT DOCS"]

    # Chapter callouts to inject after certain sections
    callouts = _make_callouts(styles, doc.width)

    for idx, chapter in enumerate(chapters, start=1):
        # Chapter opener
        story.append(Paragraph(f"Chapter {idx}", styles["h1_num"]))
        story.append(Paragraph(_title_case(chapter["title"]), styles["h1"]))
        story.append(HorizontalRule(space_after=12))

        # Render body of chapter
        for flow in _render_chapter_body(chapter["body"], styles, doc.width):
            story.append(flow)

        # Inject appropriate callout after body
        key = chapter["title"].upper().strip()
        if key in callouts:
            story.append(Spacer(1, 6))
            story.append(callouts[key])

        story.append(PageBreak())

    # -------- Glossary --------
    story.append(Paragraph(f"Chapter {len(chapters) + 1}", styles["h1_num"]))
    story.append(Paragraph("Glossary", styles["h1"]))
    story.append(HorizontalRule(space_after=12))
    for term, definition in GLOSSARY:
        story.append(Paragraph(term, styles["glossary_term"]))
        story.append(Paragraph(definition, styles["glossary_def"]))
    story.append(PageBreak())

    # -------- Index (curated, not auto-generated) --------
    story.append(Paragraph(f"Chapter {len(chapters) + 2}", styles["h1_num"]))
    story.append(Paragraph("Index of Common Tasks", styles["h1"]))
    story.append(HorizontalRule(space_after=12))
    story.append(Paragraph(
        "Quick jumping-off points for the things people ask about most often. "
        "Each entry points to the chapter that covers it in full.",
        styles["body"]))
    story.append(Spacer(1, 6))
    for topic, chapter_ref in INDEX:
        row = f'<b>{topic}</b> \u2014 <font color="#5a5a5a">{chapter_ref}</font>'
        story.append(Paragraph(row, styles["body"]))

    # -------- Colophon --------
    story.append(PageBreak())
    story.append(Paragraph("Colophon", styles["h1"]))
    story.append(HorizontalRule(space_after=12))
    story.append(Paragraph(
        f"This is the User Guide for AdvisePoint Docs version {version}, "
        f"document revision {revision}, dated {rev_date}. "
        "It ships inside the application as a seeded welcome document so a "
        "fresh install has something to search and read on day one. "
        "Body text is set in Times Roman; headings and callouts in Helvetica. "
        "The guide is generated from <font face='Courier'>packaging/README.txt</font> "
        "at build time \u2014 the source-of-truth for what the application does.",
        styles["body"]))
    story.append(Spacer(1, 12))
    story.append(Paragraph(
        "For issues or suggestions, use the in-app feedback path or update to the "
        "latest release from Settings &gt; Updates.", styles["body"]))

    # Build with per-pass page counting
    page_counter = {"n": 0, "first_body_page": None}

    def _count_page(c, d):
        page_counter["n"] = d.page
        # Detect first body page: the first page rendered under the "body" template.
        # BaseDocTemplate names the current template via canvas transformations we
        # can't easily read here, so infer instead: after cover(1) and any TOC pages,
        # the "body" template is applied on PageBreak(). Track first page where
        # d.pageTemplate.id == "body".
        if d.pageTemplate.id == "body" and page_counter["first_body_page"] is None:
            page_counter["first_body_page"] = d.page

    # Chain existing decorators with our counter
    for pt in doc.pageTemplates:
        original = pt.onPage
        def combined(c, d, _orig=original):
            _orig(c, d)
            _count_page(c, d)
        pt.onPage = combined

    doc.multiBuild(story)

    total_pages = page_counter["n"]
    first_body = page_counter["first_body_page"] or 1
    body_pages = total_pages - (first_body - 1)
    return {
        "total": total_pages,
        "body_pages": body_pages,
        "body_offset": first_body - 1,
    }


# ---------------- Chapter parsing ----------------

CHAPTER_RE = re.compile(r"^([A-Z][A-Z0-9 \-,'\/&]{2,})\n[-=]{3,}$", re.MULTILINE)

def _parse_chapters(text):
    """Split README into chapters by ALL-CAPS headings underlined with --- or ==="""
    chapters = []
    matches = list(CHAPTER_RE.finditer(text))
    for i, m in enumerate(matches):
        title = m.group(1).strip()
        body_start = m.end()
        body_end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        body = text[body_start:body_end].strip()
        chapters.append({"title": title, "body": body})
    return chapters


def _title_case(t):
    # Preserve small words in lowercase for a book-like feel
    small = {"a", "an", "and", "or", "of", "the", "for", "in", "on", "to", "with"}
    words = t.lower().split()
    out = []
    for i, w in enumerate(words):
        if i > 0 and w in small:
            out.append(w)
        else:
            out.append(w.capitalize())
    return " ".join(out)


# ---------------- Chapter body renderer ----------------

BULLET_RE       = re.compile(r"^\s*\*\s+(.+)$")
NUMBERED_RE     = re.compile(r"^\s*(\d+)\.\s+(.+)$")
SUB_BULLET_RE   = re.compile(r"^\s{4,}([a-z])\)\s+(.+)$")
INDENT_ITEM_RE  = re.compile(r"^\s{5,}\*\s+(.+)$")

def _escape(text):
    return (text.replace("&", "&amp;")
                .replace("<", "&lt;")
                .replace(">", "&gt;"))

def _inline(text):
    """Apply inline formatting: quoted UI labels -> bold, and paths/URLs/env
    vars -> monospace. Order matters: transform quoted labels FIRST (before any
    tags exist), then paths (which introduce <font> tags whose own attributes
    are quoted). We also skip anything already inside a tag by working on plain
    escaped text before adding markup."""
    text = _escape(text)
    # 1) Quoted UI labels -> bold, done on plain text before any tag is added.
    text = re.sub(r'"([^"\n]{2,60})"', r'<b>&quot;\1&quot;</b>', text)
    # 2) %LOCALAPPDATA%\... style paths -> monospace.
    # Allow interior spaces only if they sit BETWEEN word chars ("AdvisePoint Docs"),
    # never a run of trailing whitespace that would eat the rest of the sentence.
    text = re.sub(
        r"(%[A-Z_]+%\\(?:[A-Za-z0-9._\-]+(?: [A-Za-z0-9._\-]+)*\\?)+)",
        r'<font face="Courier" size="9.5">\1</font>', text)
    # 3) Absolute Windows paths -> monospace (same anti-greedy space handling).
    text = re.sub(
        r"(?<![A-Za-z0-9])([A-Z]:\\(?:[A-Za-z0-9._\-]+(?: [A-Za-z0-9._\-]+)*\\?)+)",
        r'<font face="Courier" size="9.5">\1</font>', text)
    # 4) URLs -> monospace
    text = re.sub(r"(https?://[^\s<]+)",
                  r'<font face="Courier" size="9.5">\1</font>', text)
    return text


def _render_chapter_body(body, styles, width):
    """Turn the raw chapter text block into a list of flowables."""
    flows = []
    lines = body.split("\n")
    i = 0
    para_buf = []
    bullet_buf = []
    sub_bullet_buf = []
    numbered_buf = []
    code_buf = []
    subhead_pending = None

    def flush_para():
        nonlocal para_buf
        if para_buf:
            joined = " ".join(l.strip() for l in para_buf if l.strip())
            if joined:
                flows.append(Paragraph(_inline(joined), styles["body"]))
            para_buf = []

    def flush_bullets():
        nonlocal bullet_buf
        for b in bullet_buf:
            flows.append(Paragraph(_inline(b), styles["bullet"], bulletText="\u2022"))
        bullet_buf = []

    def flush_sub_bullets():
        nonlocal sub_bullet_buf
        for b in sub_bullet_buf:
            flows.append(Paragraph(_inline(b), styles["sub_bullet"], bulletText="\u2013"))
        sub_bullet_buf = []

    def flush_numbered():
        nonlocal numbered_buf
        for num, txt in numbered_buf:
            flows.append(Paragraph(_inline(txt), styles["numbered"], bulletText=f"{num}."))
        numbered_buf = []

    def flush_code():
        nonlocal code_buf
        if code_buf:
            cleaned = [c.rstrip() for c in code_buf]
            # Strip common leading indent
            non_empty = [c for c in cleaned if c.strip()]
            if non_empty:
                min_indent = min(len(c) - len(c.lstrip()) for c in non_empty)
                cleaned = [c[min_indent:] if len(c) >= min_indent else c for c in cleaned]
            code_text = "<br/>".join(_escape(c).replace(" ", "&nbsp;") for c in cleaned)
            flows.append(Paragraph(code_text, styles["code_block"]))
        code_buf = []

    def flush_all():
        flush_para(); flush_bullets(); flush_sub_bullets(); flush_numbered(); flush_code()

    def is_sub_heading_line(line):
        # Section labels inside a chapter, e.g. "QUICK BACKUP (Column 1)"
        stripped = line.strip()
        if not stripped:
            return False
        if len(stripped) < 4 or len(stripped) > 60:
            return False
        # All caps or Title-Case-with-parentheses, no trailing period, no bullet char
        return bool(re.match(r"^[A-Z][A-Z0-9 \-\(\)]+$", stripped))

    while i < len(lines):
        line = lines[i]
        stripped = line.strip()

        # Blank line: separator
        if not stripped:
            flush_all()
            i += 1
            continue

        # Sub-heading inside a chapter
        if is_sub_heading_line(line) and (i == 0 or not lines[i-1].strip()):
            flush_all()
            flows.append(Paragraph(_title_case(stripped), styles["h2"]))
            i += 1
            continue

        # Bulleted list
        m = BULLET_RE.match(line)
        if m:
            flush_para(); flush_sub_bullets(); flush_numbered(); flush_code()
            bullet_text = m.group(1)
            # Continuation lines (indented, not another bullet/numbered)
            j = i + 1
            while j < len(lines):
                nxt = lines[j]
                if not nxt.strip():
                    break
                if BULLET_RE.match(nxt) or NUMBERED_RE.match(nxt) or SUB_BULLET_RE.match(nxt):
                    break
                if nxt.startswith("  ") and not is_sub_heading_line(nxt):
                    bullet_text += " " + nxt.strip()
                    j += 1
                else:
                    break
            bullet_buf.append(bullet_text)
            i = j
            continue

        # Sub-bullet a) b) style
        m = SUB_BULLET_RE.match(line)
        if m:
            flush_para(); flush_bullets(); flush_numbered(); flush_code()
            sub_text = m.group(2)
            j = i + 1
            while j < len(lines):
                nxt = lines[j]
                if not nxt.strip():
                    break
                if BULLET_RE.match(nxt) or NUMBERED_RE.match(nxt) or SUB_BULLET_RE.match(nxt):
                    break
                if nxt.startswith(" " * 8):
                    sub_text += " " + nxt.strip()
                    j += 1
                else:
                    break
            sub_bullet_buf.append(sub_text)
            i = j
            continue

        # Numbered list
        m = NUMBERED_RE.match(line)
        if m:
            flush_para(); flush_bullets(); flush_sub_bullets(); flush_code()
            num = m.group(1); txt = m.group(2)
            j = i + 1
            while j < len(lines):
                nxt = lines[j]
                if not nxt.strip():
                    break
                if BULLET_RE.match(nxt) or NUMBERED_RE.match(nxt) or SUB_BULLET_RE.match(nxt):
                    break
                if nxt.startswith("  ") and not is_sub_heading_line(nxt):
                    txt += " " + nxt.strip()
                    j += 1
                else:
                    break
            numbered_buf.append((num, txt))
            i = j
            continue

        # Preformatted / code block:
        # A line with 3+ leading spaces that starts a new block (previous line
        # blank or start of chapter, and not a recognized list item) begins a
        # code block. All subsequent lines that are either blank OR indented
        # 3+ spaces are gobbled into the same block, so ASCII tree diagrams,
        # aligned key/value tables, and multi-line code samples all stay put.
        leading_ws = len(line) - len(line.lstrip(" "))
        prev_blank = (i == 0) or (not lines[i - 1].strip())
        if (leading_ws >= 3 and prev_blank
                and not BULLET_RE.match(line)
                and not NUMBERED_RE.match(line)
                and not SUB_BULLET_RE.match(line)):
            flush_para(); flush_bullets(); flush_sub_bullets(); flush_numbered()
            code_buf.append(line)
            j = i + 1
            # Gobble contiguous block: blank lines are kept as separators
            # inside the code region; a non-indented non-blank line ends it.
            while j < len(lines):
                nxt = lines[j]
                if not nxt.strip():
                    # Peek ahead: if the next non-blank line is still indented,
                    # this blank belongs inside the code block; otherwise stop
                    # BEFORE the blank so the outer loop sees it as a separator.
                    k = j + 1
                    while k < len(lines) and not lines[k].strip():
                        k += 1
                    if k < len(lines) and (len(lines[k]) - len(lines[k].lstrip(" "))) >= 3:
                        code_buf.append("")
                        j = k
                        continue
                    break
                nxt_ws = len(nxt) - len(nxt.lstrip(" "))
                if nxt_ws >= 3:
                    code_buf.append(nxt)
                    j += 1
                else:
                    break
            i = j
            continue

        # Plain paragraph line
        flush_bullets(); flush_sub_bullets(); flush_numbered(); flush_code()
        para_buf.append(line)
        i += 1

    flush_all()
    return flows


# ---------------- Callouts (post-chapter tips) ----------------

def _make_callouts(styles, width):
    def body(text):
        return [Paragraph(text, styles["callout_body"])]

    return {
        "SYSTEM REQUIREMENTS": Callout(
            "help", "Help \u2014 Sizing the library folder",
            body("Uploaded documents live under %LOCALAPPDATA%\\AdvisePoint Docs, "
                 "not inside the app folder. If your system drive is tight, "
                 "make sure %LOCALAPPDATA% has room for roughly three to four "
                 "times the total size of the documents you plan to index."),
            width,
        ),
        "QUICK START": Callout(
            "tip", "Tip \u2014 Pin it once, launch it forever",
            body("After setup, right-click the AdvisePoint Docs shortcut and "
                 "choose Pin to Taskbar. From then on the app is one click away, "
                 "and the browser opens straight to the interface."),
            width,
        ),
        "INSTALL LOCATION - RECOMMENDED FOLDER SETUP": Callout(
            "warn", "Warning \u2014 Do not install into a cloud-sync folder",
            body("OneDrive, Dropbox, Google Drive, iCloud, and Box can mark files "
                 "as online-only, hold write locks on the database, or trip DLP "
                 "rules that block uploads. Keep the app on a plain local drive."),
            width,
        ),
        "ADDING YOUR OWN DOCUMENTS": Callout(
            "help", "Help \u2014 Getting the most out of metadata",
            body("Product model is optional, but it's the primary way filtered "
                 "searches narrow down results, so fill it in when a document "
                 "belongs to specific machines. The Upload tab suggests it from "
                 "the filename, and you can leave it blank for documents that "
                 "aren't model-specific, like price lists or software notes. "
                 "Tags autocomplete from what you've used before, so similar "
                 "documents naturally end up with matching labels \u2014 which "
                 "makes them easier to find later."),
            width,
        ),
        "SEARCHING": Callout(
            "tip", "Tip \u2014 Try natural questions first",
            body("Smart match mode blends keyword and semantic search, so a question "
                 "like \"how do I reset the fuser count\" usually works better than "
                 "a bag of keywords. Fall back to Phrase for exact strings and "
                 "Semantic for meaning-only searches."),
            width,
        ),
        "MANAGING DUPLICATES": Callout(
            "help", "Help \u2014 Nothing is destroyed by default",
            body("Removed duplicates go to a quarantine folder, not the recycle bin. "
                 "You can restore any of them from Settings &gt; Recovery. "
                 "Permanent deletion is always an explicit, per-item choice unless "
                 "you opt in to the auto-cleanup sweep."),
            width,
        ),
        "BACKUP AND RECOVERY": Callout(
            "warn", "Warning \u2014 A wipe restore replaces your library",
            body("Choose Merge if you want to add documents from a backup without "
                 "changing what's already in the library. Every wipe restore keeps "
                 "a pre-restore snapshot next to your data folder, so a mistake is "
                 "always recoverable with the app closed."),
            width,
        ),
        "TROUBLESHOOTING": Callout(
            "tip", "Tip \u2014 Check the log before assuming the worst",
            body("<font face='Courier' size='9'>%LOCALAPPDATA%\\AdvisePoint Docs\\server.log</font> "
                 "is a rolling log of everything the app did in this session. Most "
                 "\"it won't start\" and \"upload failed\" questions are answered by "
                 "the last few lines."),
            width,
        ),
    }


# ---------------- Glossary ----------------

GLOSSARY = [
    ("Backup",
     "A timestamped ZIP containing the SQLite database, rendered page images, and "
     "original uploaded files \u2014 everything needed to restore the library on the "
     "same machine or a different one."),
    ("Chunk",
     "A short searchable excerpt of a document, produced by the indexer at upload "
     "time. Search results return matching chunks with their parent document."),
    ("Confidentiality Ceiling",
     "A per-document setting (public / internal / restricted) that lets you exclude "
     "higher-sensitivity documents from a search using the \"Show up to\" filter."),
    ("Dist.bak",
     "A copy of the previous application build kept next to the new one after an "
     "update. If the swap fails, the updater restores it automatically. Superseded "
     "on the next successful update."),
    ("Document Type",
     "A metadata category applied at upload time (Service Guide, Admin Guide, "
     "Release Notes, etc.). Used for filtering searches. Names are stored in "
     "Title Case, and the list is editable in Settings > Document types."),
    ("Keeper",
     "In duplicate handling, the document chosen to remain in the library while the "
     "other copies are moved to quarantine."),
    ("Match Mode",
     "The strategy used to rank a query: Smart (default hybrid), Phrase "
     "(exact-phrase), or Semantic (meaning-only)."),
    ("Merge Restore",
     "A restore mode that adds documents from a backup that are not already in the "
     "library. Existing documents with the same id are skipped, never overwritten."),
    ("Pre-Restore Snapshot",
     "A copy of the live data directory saved automatically before a wipe restore, "
     "under <font face='Courier'>%LOCALAPPDATA%\\AdvisePoint Docs.bak-&lt;timestamp&gt;\\</font>. "
     "You can restore from it manually with the app closed."),
    ("Product Family",
     "The top-level product line a document belongs to (e.g. \"AdvisePoint\", "
     "\"MZ Series\"). Independent from Product model \u2014 the two filters do not "
     "narrow each other."),
    ("Product Model",
     "The specific product a document describes (e.g. \"MZ9500ci\"). Required at "
     "upload time; the primary filtering axis for search."),
    ("Quarantine",
     "The <font face='Courier'>deleted\\</font> folder under the data directory where "
     "removed documents are stored non-destructively until you Restore them or "
     "delete them permanently."),
    ("Recovery Panel",
     "The Settings &gt; Recovery view listing quarantined documents and pre-restore "
     "snapshots, with per-item Restore and Delete actions and an opt-in auto-cleanup "
     "toggle for duplicates."),
    ("Sha-256",
     "A cryptographic hash the app computes over every uploaded file and every "
     "backup ZIP. Used to detect duplicate uploads and to verify a backup before "
     "restoring from it."),
    ("Smartscreen",
     "The Windows security prompt (\"Windows protected your PC\") shown for files "
     "marked as downloaded from the internet. Both AdvisePoint launcher batch files "
     "strip that mark from the folder on first run so subsequent launches are silent."),
    ("Stage-Verify-Swap",
     "The safety pattern used by the updater and by restore: the new content is "
     "unpacked into a staging directory, verified end-to-end, and only then swapped "
     "in. If verification fails, nothing is replaced."),
    ("Wipe Restore",
     "A restore mode that replaces the entire live library with the backup contents. "
     "Requires typed confirmation and creates a pre-restore snapshot."),
]

# ---------------- Curated task index ----------------

INDEX = [
    # v1.1.0: System Requirements was added as Chapter 1, shifting every
    # existing entry down by one. Titles alone drive the running header
    # and TOC; only the "Chapter N" numbers in this static list have to
    # be nudged when chapters are inserted or removed.
    ("Check system requirements before installing", "Chapter 1 \u2014 System Requirements"),
    ("Estimate disk space for the library", "Chapter 1 \u2014 System Requirements"),
    ("Install for the first time", "Chapter 2 \u2014 Quick Start"),
    ("Update to a newer version", "Chapter 3 \u2014 Updating"),
    ("Move the app off OneDrive", "Chapter 4 \u2014 Install Location"),
    ("Upload a document", "Chapter 5 \u2014 Adding Your Own Documents"),
    ("Run a search", "Chapter 6 \u2014 Searching"),
    ("Filter results by product family", "Chapter 6 \u2014 Searching"),
    ("Edit a document's metadata", "Chapter 7 \u2014 Library Management"),
    ("Find and clean up duplicates", "Chapter 8 \u2014 Managing Duplicates"),
    ("Restore a document you removed", "Chapter 8 \u2014 Managing Duplicates"),
    ("Take an ad-hoc backup", "Chapter 9 \u2014 Backup and Recovery"),
    ("Schedule automatic backups", "Chapter 9 \u2014 Backup and Recovery"),
    ("Restore from a backup file", "Chapter 9 \u2014 Backup and Recovery"),
    ("Find your data folder", "Chapter 10 \u2014 Where Your Data Lives"),
    ("Resolve SmartScreen or antivirus warnings", "Chapter 11 \u2014 Troubleshooting"),
    ("Roll back a failed update", "Chapter 11 \u2014 Troubleshooting"),
    ("Uninstall completely", "Chapter 13 \u2014 Removing the App"),
    ("Look up a technical term", "Chapter 14 \u2014 Glossary"),
]


# ---------------- CLI ----------------

def main():
    root = Path(__file__).resolve().parent.parent
    readme = root / "packaging" / "README.txt"
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else (root / "build-out" / "AdvisePoint-Docs-Welcome-Guide.pdf")
    out.parent.mkdir(parents=True, exist_ok=True)
    # Application version from the README's VERSION section (near end of file):
    #   AdvisePoint Docs X.Y.Z[.W]
    # Search only after the VERSION heading so we don't pick up numbers in
    # sample paths above (e.g. "Node.js 20.18.1").
    text = readme.read_text(encoding="utf-8")
    version = "1.0.14"
    ver_section = re.search(r"VERSION\s*\n[-=]+\s*\n+(.+)", text)
    if ver_section:
        m = re.search(r"AdvisePoint Docs\s+(\d+\.\d+\.\d+(?:\.\d+)?)", ver_section.group(1))
        if m:
            version = m.group(1)
    # Document revision defaults to app version; override with arg 2. Date is today.
    revision = sys.argv[2] if len(sys.argv) > 2 else version
    try:
        rev_date = date.today().strftime("%B %-d, %Y")
    except ValueError:
        rev_date = date.today().strftime("%B %d, %Y").replace(" 0", " ")
    render(readme, out, version, revision, rev_date)
    print(f"Wrote {out} (app v{version}, doc rev {revision}, {rev_date})")


if __name__ == "__main__":
    main()
