const assert=require('node:assert/strict'), L=require('../vendor/pdf-lib.min.js'), engine=require('../pdf-scrubber')(L);
async function test(name,fn){try{await fn();console.log('PASS '+name);}catch(e){console.log('FAIL '+name+': '+e.stack);process.exitCode=1;}}
async function sample(lines){ const d=await L.PDFDocument.create(),c=d.context,p=d.addPage(); p.node.set(L.PDFName.of('Resources'),c.obj({Font:{F1:c.register(c.obj({Type:'Font',Subtype:'Type1',BaseFont:'Helvetica'}))}})); p.node.set(L.PDFName.of('Contents'),c.register(c.flateStream(lines.map((x,i)=>`BT /F1 10 Tf 20 ${300-i*20} Td (${x}) Tj ET`).join('\n')))); return d.save(); }
async function text(bytes){const d=await L.PDFDocument.load(bytes,{updateMetadata:false}); return d.context.enumerateIndirectObjects().filter(([,x])=>x instanceof L.PDFRawStream).map(([,x])=>Buffer.from(L.decodePDFRawStream(x).decode()).toString('latin1')).join('\n');}
(async()=>{
 await test('download and print labels accept date-only stamps and varied timestamp formats',async()=>{
   const lines=['Downloaded on: 10/9/2026','Print date: 2026-10-09 09:19:22','Printed: 9.10.2026 9:19 AM','2026-10-09 09:19:22','Revision date: 10/09/2026','Diagnostic body'];
   const out=await engine.scrub(await sample(lines),{strings:['D7MASALL'],timestamp:true}),s=await text(out.bytes);
   assert.equal(out.report.removedText.length,4); assert(s.includes('Revision date: 10/09/2026')); assert(s.includes('Diagnostic body'));
 });
 await test('the fixed user ID is matched across spacing without removing unrelated revision text',async()=>{
   const out=await engine.scrub(await sample(['D7M ASALL','d7masall','Revision 2026-10-09','Diagnostic body']),{strings:['D7MASALL'],timestamp:true}),s=await text(out.bytes);
   assert.equal(out.report.removedText.length,2); assert(!/D7M ASALL|d7masall/.test(s)); assert(s.includes('Revision 2026-10-09'));
 });
 process.exit(process.exitCode||0);
})();
