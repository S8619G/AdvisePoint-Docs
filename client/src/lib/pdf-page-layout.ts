// v1.2.7: geometry is independent of image loading and mounted DOM nodes.
export type PdfPageSize = { page_number: number; width: number; height: number };
export type PdfPageSlot = {
  page: number; top: number; height: number; imageWidth: number;
  imageHeight: number; separator: number;
};

export function buildPdfPageLayout(
  pages: PdfPageSize[], total: number, width: number, height: number, zoomed: boolean,
): PdfPageSlot[] {
  if (width <= 0 || height <= 0 || total <= 0) return [];
  const byNumber = new Map(pages.map(p => [p.page_number, p]));
  const fallback = pages.find(p => p.width > 0 && p.height > 0) ?? {width:612,height:792};
  let top = 0;
  return Array.from({length:total}, (_, index) => {
    const info = byNumber.get(index + 1) ?? fallback;
    const w = info.width > 0 ? info.width : fallback.width;
    const h = info.height > 0 ? info.height : fallback.height;
    const scale = Math.min(1, Math.max(1, width - 32) / w,
      Math.max(1, height - 32) * (zoomed ? 2.2 : 1) / h);
    const separator = index === 0 ? 0 : 32;
    const slot = {page:index + 1, top, height:h * scale + 16 + separator,
      imageWidth:w * scale, imageHeight:h * scale, separator};
    top += slot.height;
    return slot;
  });
}

export function pdfPageAtOffset(slots: PdfPageSlot[], offset: number): number {
  if (!slots.length) return 0;
  let lo = 0, hi = slots.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (slots[mid].top + slots[mid].height <= offset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function pdfVisibleWindow(slots: PdfPageSlot[], top: number, height: number) {
  if (!slots.length) return {start:0,end:-1};
  return {
    start:Math.max(0, pdfPageAtOffset(slots, top) - 2),
    end:Math.min(slots.length - 1, pdfPageAtOffset(slots, top + height) + 2),
  };
}
