// All code/resources are local. No automatic print, plugin, CDN, or app-shell
// fallback. Only a validated document ID and integer page range enter HTML.
export function pdfPrintHtml(id:string,from:number,to:number):string {
  if(!/^[a-zA-Z0-9_-]+$/.test(id))throw new Error("Invalid document ID");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AdvisePoint Docs - Print preview</title>
<style>
:root{color-scheme:light;font:13px/1.4 system-ui;color:#222;background:#eef0f3}
*{box-sizing:border-box}body{margin:0}header{max-width:920px;margin:12px auto 0;padding:12px 16px;background:#fffdf5;border:1px solid #ddcf9b;border-top:3px solid #d6a226;border-radius:7px}
.heading{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:4px 16px}
h1{font-size:16px;line-height:1.3;margin:0}.identity{font-size:12px;color:#665522}
p{margin:6px 0}.actions{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
button,a{font:inherit;background:white;border:1px solid #aa9c76;border-radius:5px;padding:5px 9px;color:#222;text-decoration:none;cursor:pointer}
button:disabled{opacity:.5;cursor:not-allowed}button:focus-visible,a:focus-visible{outline:3px solid #2268b3;outline-offset:2px}
#print{background:#273c43;color:white;border-color:#273c43;font-weight:600}#error{color:#9b1c1c}
#external-status:empty{display:none}details{margin-top:7px;font-size:12px;color:#555}summary{cursor:pointer;width:fit-content}
summary:focus-visible{outline:3px solid #2268b3;outline-offset:2px}
main{padding:12px}.sheet{margin:0 auto 12px;background:white;max-width:min(100%,420px);width:fit-content;box-shadow:0 1px 5px #0003}
#pdf-help{max-width:920px;margin:12px auto;padding:16px;background:white;border:1px solid #ccc;border-radius:7px}#pdf-range{font-weight:600}
#fallback-offer{padding:10px;margin:8px 0;border:1px solid #b68b35;background:#fff8df;border-radius:5px}
.sheet img{display:block;width:100%;height:auto}.caption{text-align:center;padding:4px;color:#555;font-size:12px}
@media(max-width:944px){header{margin:8px 12px 0}}
[hidden]{display:none!important}#print-warning{display:none}
@media print{
@page{margin:0}html,body{background:white;margin:0;padding:0}header,.caption{display:none!important}
main{padding:0}.sheet{margin:0;max-width:none;box-shadow:none;break-after:page;break-inside:avoid}
.sheet:last-child{break-after:auto}.sheet img{width:100%;height:100%;object-fit:contain}
body:not([data-ready="true"]) main,body[data-print-mode="pdf"] main,body[data-print-mode="original-range"] main{display:none}
body:not([data-ready="true"]) #print-warning,body[data-print-mode="pdf"] #print-warning,body[data-print-mode="original-range"] #print-warning{display:block;padding:20mm}
#pdf-help{display:none}
}
</style><style id="page-sizes"></style></head>
<body data-document="${id}" data-from="${from}" data-to="${to}" data-ready="false">
<header><div class="heading"><h1>Print preview · ${from===to?`Page ${from}`:`Pages ${from}–${to}`}</h1>
<span class="identity">AdvisePoint Docs</span></div>
<p id="status" role="status">Preparing selected pages locally…</p>
<p id="error" role="alert" hidden></p>
<div id="fallback-offer" role="status" hidden><p id="fallback-message"></p><button id="fallback-open">Open in PC PDF app</button></div>
<div class="actions">
<button id="print" disabled>Print selected pages</button>
<a id="prepared-download" hidden>Download prepared PDF</a>
<button id="cancel">Cancel preparation</button><button id="retry" hidden>Prepare again</button>
<button id="open-original">Open original in PC PDF app</button>
<a id="download" href="/api/documents/${id}/original" download="AdvisePoint-original.pdf">Download original PDF</a>
</div>
<p id="external-status" role="status"></p>
<details><summary>Print help</summary>
<p>Large job or print issue? Open the original in your Windows default PDF app, or download it. Chrome, Edge and Firefox use your configured PDF-reader or download settings. External edits do not change your library.</p>
<p>There is no 20-page maximum for retained PDFs. In the app dialog, all selections use PDFs rather than allocating page images. Your browser or default PDF app handles its final print dialog. Loading that PDF in the reader is not a second preparation job.</p>
<p>For protected PDFs, a larger range may require selecting the page range in the original PDF's print dialog. After one minute of preparation, a warning offers your PC's PDF program while you can keep waiting. After two minutes preparation stops. Time, size or preparation failures also offer the original-PDF route. No app is opened and no job is sent to a printer automatically.</p>
</details>
</header>
<p id="print-warning">This preparation page is not the printable PDF. Cancel this dialog. If a PDF is ready, use Open PDF to print (or Open original to choose range) and print from that PDF's own toolbar. Otherwise use Prepare again.</p>
<section id="pdf-help" hidden aria-label="Large PDF printing"><p id="pdf-range"></p><p id="pdf-instructions"></p><p>If the browser downloads PDFs instead of displaying them, open the downloaded PDF in your usual PDF reader.</p></section>
<main id="pages" aria-label="Prepared PDF pages"></main>
<script type="module" src="/pdf-print.js"></script>
</body></html>`;
}
