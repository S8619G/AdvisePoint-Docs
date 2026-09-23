'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const [file,role]=process.argv.slice(2);
const progress=stage=>process.send?.({type:'progress',stage});
const normalized = s => String(s || '').replace(/\s+/g, ' ').trim();
async function inspectPdf() {
  if(!process.send || !file || !['original','converted'].includes(role))throw Error('Start PDF inspection through the lab supervisor.');
  progress('Loading PDF inspection dependencies');
  const {PDFParse} = require('pdf-parse');
  progress('Opening PDF and reading page permissions');
  const parser = new PDFParse({data:new Uint8Array(fs.readFileSync(file))});
  try {
    const info = await parser.getInfo({parsePageInfo:true});
    const permissions = info.permission;
    const canPrint = !Array.isArray(permissions) || (permissions.includes(4) && permissions.includes(2048));
    const canCopy = !Array.isArray(permissions) || permissions.includes(16);
    if (!canCopy && !canPrint && role === 'original') throw Error('This restricted PDF does not permit high-quality printing. No conversion attempted.');
    if (!canCopy && role === 'converted') throw Error('The converted PDF still restricts extraction. Not accepted.');
    if (!info.pages?.length || info.pages.length > 2000) throw Error('Automatic PDF preparation accepts 1 to 2,000 pages.');
    // User-initiated, authorized comparison only, analogous to the existing
    // explicit rendered fallback. Never indexes restricted original text.
    progress('Reading searchable text for page-by-page comparison');
    const text = await parser.getText();
    if (text.total !== info.pages.length || text.pages?.length !== info.pages.length) throw Error('Incomplete PDF extraction.');
    const pageTexts = text.pages.map(p => normalized(p.text));
    return {
      pages:info.pages.map(p => ({number:p.pageNumber,width:p.width,height:p.height})),
      permissions, canPrint, canCopy,
      pageTextHashes:pageTexts.map(s => crypto.createHash('sha256').update(s).digest('hex')),
      pageCharacters:pageTexts.map(s => s.length),
      text:role === 'converted' ? text.text : undefined,
      characters:pageTexts.reduce((n,s) => n+s.length,0)
    };
  } finally {progress('Closing PDF inspection');await parser.destroy();}
}
function finish(message) {
  if(!process.send){console.error(message.error || 'Missing supervisor.');process.exitCode=1;return}
  process.send(message,error=>{
    if(error)process.exitCode=1;
    if(process.connected)process.disconnect();
  });
}
inspectPdf().then(result=>finish({type:'result',ok:true,result})).catch(e=>finish({
  type:'result',ok:false,error:e.name === 'PasswordException'
    ? 'This PDF requires an opening password. No conversion attempted.' : e.message
}));
