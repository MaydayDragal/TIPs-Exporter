// Real PDF fixtures for endpoint/UI tests. Network and native file handles stay simulated.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const L = require('../../vendor/pdf-lib.min.js');
const cache = new Map();
function makePdf(text = 'Fixture PDF', size = 0) {
  const key = JSON.stringify([text,size]);
  if (!cache.has(key)) cache.set(key, (async () => {
    const d = await L.PDFDocument.create(), c = d.context, p = d.addPage();
    p.node.set(L.PDFName.of('Resources'), c.obj({ Font: { F1: c.register(c.obj({Type:'Font',Subtype:'Type1',BaseFont:'Helvetica'})) } }));
    p.node.set(L.PDFName.of('Contents'), c.register(c.flateStream(`BT /F1 12 Tf 20 200 Td (${text.replace(/[\\()]/g,'\\$&')}) Tj ET`)));
    // Preserve the intended payload size for tests of ZIP limits, without fake PDF bytes.
    if (size) d.catalog.set(L.PDFName.of('FixturePadding'), c.register(L.PDFRawStream.of(c.obj({Length:size}),new Uint8Array(size))));
    return d.save();
  })());
  return cache.get(key);
}
function installPdfFixtures(w) {
  Object.assign(w,{TextEncoder,TextDecoder,Blob,Response,CompressionStream});
  for (const f of ['vendor/pdf-lib.min.js','pdf-scrubber.js']) w.eval(fs.readFileSync(path.join(__dirname,'../..',f),'utf8'));
  const original=w.fetch;
  w.fetch=async(...args)=>{
    const r=await original(...args); if (!r?.arrayBuffer) return r;
    const read=r.arrayBuffer.bind(r);
    return {...r,arrayBuffer:async()=>{
      const bytes=new Uint8Array(await read());
      if (!bytes.length || bytes.every(x=>x===0)) { const pdf=await makePdf('Fixture PDF',bytes.length); return pdf.slice().buffer; }
      return bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
    }};
  };
}
async function assertSavedPdf(root, path, version) {
  const bits=path.split('/'), name=bits.pop(); let folder=root;
  for(const part of bits) folder=await folder.getDirectoryHandle(part);
  const file=await(await folder.getFileHandle(name)).getFile();
  const doc=await L.PDFDocument.load(await file.arrayBuffer(),{updateMetadata:false});
  const streams=doc.context.enumerateIndirectObjects().filter(([,o])=>o instanceof L.PDFRawStream).map(([,o])=>Buffer.from(L.decodePDFRawStream(o).decode()).toString('latin1')).join('\n');
  assert(streams.includes(`version ${version}`),path+' retains its document body');
  assert.equal(doc.context.trailerInfo.Info,undefined,'new PDF metadata is scrubbed');
}
module.exports={makePdf,installPdfFixtures,assertSavedPdf};
