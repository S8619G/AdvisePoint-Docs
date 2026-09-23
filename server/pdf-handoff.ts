// Large selections open unchanged source bytes. No PDF parsing or image work.
export const ORIGINAL_HANDOFF_THRESHOLD = 50;
export function pdfHandoffHtml(id:string,from:number,to:number,total:number,available:boolean,rendered:boolean,canAttach:boolean){
  if(!/^[a-zA-Z0-9_-]+$/.test(id))throw Error("Invalid document ID");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AdvisePoint Docs - Print original PDF</title><style>
:root{font:15px/1.5 system-ui;color:#222;background:#eef0f3}*{box-sizing:border-box}
main{max-width:800px;margin:20px auto;padding:20px;background:white;border:1px solid #ccc;border-radius:8px}
h1{font-size:20px;margin-top:0}button,a{display:inline-block;font:inherit;color:inherit;background:white;border:1px solid #888;border-radius:5px;padding:7px 12px;text-decoration:none;cursor:pointer;margin:4px 4px 4px 0}
a.primary{background:#273c43;color:white}button:focus-visible,a:focus-visible,input:focus-visible{outline:3px solid #2675ad}
button:disabled{opacity:.5;cursor:wait}#error{color:#a00}#range{font-weight:600;background:#fff4ce;padding:10px}
[hidden]{display:none!important}input{max-width:100%}small{color:#555}@media(max-width:820px){main{margin:10px}}
@media print{main{display:none}body:after{content:"Open the original PDF, then print from its reader. This control panel is not the manual.";display:block;padding:30px}}
</style></head><body data-document="${id}" data-from="${from}" data-to="${to}" data-total="${total}" data-available="${available}" data-rendered="${rendered}"><main>
<h1>Print ${to-from+1} pages from the original PDF</h1>
<p>Selections over 50 pages use the unchanged original when available. No page-image preparation is needed.</p>
<p id="range">${from===1&&to===total?`Whole manual: ${total} pages. Choose All pages in the PDF reader.`:`The FULL original opens. In the reader's print dialog, select pages ${from}–${to}. Do not leave All pages selected.`}</p>
<p id="status" role="status">${available?"Ready to open the original PDF.":"The original PDF is not available for this entry."}</p>
<p id="error" role="alert" hidden></p>
<div id="handoff" ${available?"":"hidden"}>
<a class="primary" id="open" href="/api/documents/${id}/original" target="_blank" rel="noopener noreferrer">Open original PDF</a>
<a id="download" href="/api/documents/${id}/original" download="AdvisePoint-original.pdf">Download original PDF</a>
</div>
<div id="attach-section" ${!available&&canAttach?"":"hidden"}>
<p>Attach the exact PDF used for this import. Its file fingerprint must match; your pages, metadata and search index stay unchanged. A copy is stored in the library and included in backups.</p>
<label for="original-file">Original PDF file</label><br><input id="original-file" type="file" accept=".pdf,application/pdf">
<button id="attach">Verify and attach original</button>
</div>
${!available&&!canAttach?(rendered?"<p>The original cannot be verified for this older entry. Use prepared pages instead; the existing library will not be changed.</p>":"<p>The retained original is missing. Restore it from a verified library backup; this dialog cannot reconstruct it.</p>"):""}
<button id="fallback" ${rendered?"":"hidden"}>Prepare from saved pages instead</button>
<small>Nothing prints automatically. The PDF reader handles its own loading, preview and document restrictions. Chrome, Edge and Firefox may open or download according to your settings. Keep this dialog open until finished, then use Done. Done cleans app-owned temporary copies, not the library original or files you download.</small>
</main><script type="module" src="/pdf-handoff.js"></script></body></html>`;
}
