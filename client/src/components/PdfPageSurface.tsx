import {forwardRef, type ComponentProps, type Ref} from "react";
import {NativePdfPage} from "./NativePdfPage";

// Existing image-only libraries keep their viewer. Empty geometry rows from
// retained PDFs are routed explicitly by metadata, never mistaken for images.
export const PdfPageSurface = forwardRef<HTMLCanvasElement|HTMLImageElement,
  ComponentProps<typeof NativePdfPage> & {nativePdf:boolean}>(function PdfPageSurface(
  {nativePdf,documentId,page,width,height,onReady,className,style,...rest},ref) {
  if (nativePdf) return <NativePdfPage {...rest} ref={ref as Ref<HTMLCanvasElement>}
    documentId={documentId} page={page} width={width} height={height}
    onReady={onReady} className={className} style={style}/>;
  return <img ref={ref as Ref<HTMLImageElement>} src={`/api/documents/${documentId}/pages/${page}.jpg`}
    alt={`Page ${page}`} width={width} height={height} draggable={false}
    onLoad={onReady} onError={onReady} className={className} style={style}
    data-testid={`img-page-${page}`}/>;
});
