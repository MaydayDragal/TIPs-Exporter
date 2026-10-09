const assert = require('node:assert/strict');
const { connected, content, until, tick, LI, ITEM, TOPIC, pdf } = require('./helpers/documents-env');
const L = require('../vendor/pdf-lib.min.js');
async function test(name, fn) { try { await fn(); console.log('PASS ' + name); } catch(e) { console.log('FAIL ' + name + ': ' + e.stack); process.exitCode = 1; } }
async function fixture() {
  const d = await L.PDFDocument.create(), c = d.context, p = d.addPage();
  d.setAuthor('D7MASALL');
  p.node.set(L.PDFName.of('Resources'), c.obj({ Font: { F1: c.register(c.obj({ Type:'Font', Subtype:'Type1', BaseFont:'Helvetica' })) } }));
  p.node.set(L.PDFName.of('Contents'), c.register(c.flateStream('BT /F1 12 Tf 20 200 Td (Diagnostic procedure) Tj ET BT /F1 9 Tf 20 20 Td (D7MASALL) Tj ET BT /F1 9 Tf 20 35 Td (10/09/2026 09:00:00) Tj ET')));
  return d.save();
}
async function runSync(c,e) { e.messages.length=0; c.$('library_sync').click(); await until(()=>e.messages.some(x=>x.action==='end'),'sync'); await until(()=>!c.$('library_sync').disabled,'sync idle'); }
(async()=>{
  await test('the local library is the home screen and manual exports are under Advanced', async()=>{
    const e=await connected(), c=await content(e,undefined,{section:"library"});
    try {
      assert(c.$('tolibrary'), 'Library navigation exists'); c.$('tolibrary').click();
      assert(!c.$('library_panel').hidden); assert(c.$('advanced_panel').hidden); assert.match(c.$('library_panel').textContent,/Local LI library/);
      assert(c.$('doc_scan') && c.$('library_sync') && c.$('library_folders'));
      c.$('toadvanced').click(); assert(!c.$('advanced_panel').hidden); assert(c.$('library_panel').hidden);
      assert(c.$('look') && c.$('tobulk')); c.$('tobulk').click(); assert(c.$('prep'));
      c.$('tolibrary').click(); assert(!c.$('library_panel').hidden); assert(c.$('advanced_panel').hidden);
    } finally { c.close(); }
  });
  await test('Sync now checks recent changes once and saves a scrubbed missing PDF in the existing folder', async()=>{
    const e=await connected(), original=await fixture(); e.state.settings.pdfScrub={enabled:false,timestamp:false,user:false,strings:''};
    const c=await content(e,async(u,_o,h)=>u.includes('/file/topics/')?h.binary(original):null,{section:"library"});
    try {
      assert(c.$('library_sync'), 'Unified sync exists'); await runSync(c,e);
      assert.equal(c.requests.filter(u=>u.includes('/search')).length,1); assert.equal(c.requests.filter(u=>u.includes('/file/topics/')).length,1);
      const folder=await(await e.d.getDirectoryHandle('Batch 001')).getDirectoryHandle(`${LI} - Old title (Requested)`);
      const d=await L.PDFDocument.load((await folder.getFileHandle(`${LI}_v5.pdf`)).bytes,{updateMetadata:false}); let text='';
      for(const[,o]of d.context.enumerateIndirectObjects()) if(o instanceof L.PDFRawStream) text+=Buffer.from(L.decodePDFRawStream(o).decode()).toString('latin1');
      assert(text.includes('Diagnostic procedure')); assert(!/D7MASALL|10\/09\/2026/.test(text)); assert.equal(d.context.trailerInfo.Info,undefined);
      assert.equal(await e.d.read(`${TOPIC}/${LI}_v4.pdf`),pdf(4)); assert.equal(await e.d.read(`${TOPIC}/Attachments and Links/photo.jpg`),'old photo');
      c.requests.length=0; await runSync(c,e); assert.equal(c.requests.length,1,'unchanged sync only needs the recent index search');
    } finally { c.close(); }
  });
  await test('Sync now includes indexed missing documents and preserves unrelated catalogue progress',async()=>{
    const e=await connected(), other='LI20.10-P-075374', original=await fixture(); e.state.index.push({...ITEM,tips:other,tipsId:102,version:1}); const before=JSON.stringify(e.state.done);
    const c=await content(e,async(u,_o,h)=>{
      if(u.includes('/file/topics/'))return h.binary(original);
      if(u.includes('/topics/102/'))return h.json({version:1,attachments:[],references:[],history:{children:[]}});
    },{section:"library"});
    try { assert(c.$('library_sync')); await runSync(c,e); assert(await e.d.read(`${other} - New title (Requested)/${other}_v1.pdf`)); assert.equal(JSON.stringify(e.state.done),before); }
    finally { c.close(); }
  });
  await test('automatic library sync uses one switch even when legacy bulk auto-check was disabled',async()=>{
    const e=await connected({auto:true}), original=await fixture(); e.state.settings.autoCheck=false;
    const c=await content(e,async(u,_o,h)=>u.includes('/file/topics/')?h.binary(original):null,{startAuto:true,section:"library"});
    try {
      await until(()=>e.messages.some(x=>x.action==='end'),'automatic library sync'); await until(()=>!c.$('library_sync').disabled);
      assert.equal(c.requests.filter(u=>u.includes('/search')).length,1); assert.equal(c.requests.filter(u=>u.includes('/file/topics/')).length,1);
      c.$('library_auto').checked=false; c.$('library_auto').dispatchEvent(new c.w.Event('change')); await until(()=>e.state.documentsFolder.auto===false);
      assert.equal((await e.db.get('documentsConnection')).auto,false);
    } finally { c.close(); }
  });
  await test('required PDF cleanup cannot be disabled through old saved settings or the Settings controls',async()=>{
    const e=await connected(); e.state.settings.pdfScrub={enabled:false,timestamp:false,strings:'CUSTOM'}; const c=await content(e,undefined,{section:"library"});
    try { c.$('gear').click(); assert(c.$('s_pdfEnabled').checked && c.$('s_pdfEnabled').disabled); assert(c.$('s_pdfTimestamp').checked && c.$('s_pdfTimestamp').disabled); assert.match(c.root().textContent,/D7MASALL/); assert.equal(c.$('s_pdfStrings').value,'CUSTOM'); }
    finally { c.close(); }
  });
  await test('pausing automatic sync during startup prevents the queued index check',async()=>{
    const e=await connected({auto:true}), c=await content(e,undefined,{startAuto:true,section:'library'});
    try {
      c.$('library_auto').checked=false; c.$('library_auto').dispatchEvent(new c.w.Event('change'));
      await until(()=>e.state.documentsFolder.auto===false); await tick(1800);
      assert.deepEqual(c.requests,[],'paused library makes no startup TIPS requests');
    } finally { c.close(); }
  });
  await test('Sync respects the missing-folders choice and locally scans with no TIPS calls',async()=>{
    const e=await connected(), other='LI20.10-P-075374'; e.state.index.push({...ITEM,tips:other,tipsId:102,version:1});
    const c=await content(e,async(u,_o,h)=>{
      if(u.includes('/file/topics/102/'))return h.binary(await fixture());
      if(u.includes('/topics/102/'))return h.json({version:1,attachments:[],references:[],history:{children:[]}});
    },{section:'library'});
    try {
      c.$('library_missing').checked=false; c.$('library_missing').dispatchEvent(new c.w.Event('change')); await until(()=>e.state.settings.libraryIncludeMissing===false);
      c.$('doc_missing').checked=true; c.$('doc_missing').dispatchEvent(new c.w.Event('change'));
      c.$('doc_scan').click(); await until(()=>c.$('doc_report')); assert.deepEqual(c.requests,[]);
      await runSync(c,e); assert(!c.requests.some(u=>u.includes('/topics/102/')));
      await assert.rejects(e.d.read(`${other} - New title (Requested)/${other}_v1.pdf`),/NotFound/);
      assert.equal(c.requests.filter(u=>u.includes('/search')).length,1);
    } finally { c.close(); }
  });
  await test('automatic sync creates an indexed missing folder and skips known unavailable versions',async()=>{
    const e=await connected({auto:true}), other='LI20.10-P-075374'; e.state.index.push({...ITEM,tips:other,tipsId:102,version:1});
    e.state.index[0].exceptions=[{version:5,kind:'unavailable',reason:'v5 not available',at:new Date().toISOString()}];
    const c=await content(e,async(u,_o,h)=>{
      if(u.includes('/file/topics/102/')) return h.binary(await fixture());
      if(u.includes('/topics/102/')) return h.json({version:1,attachments:[],references:[],history:{children:[]}});
    },{startAuto:true,section:'library'});
    try {
      await until(()=>e.messages.some(x=>x.action==='end')); await until(()=>!c.$('library_sync').disabled);
      assert(await e.d.read(`${other} - New title (Requested)/${other}_v1.pdf`));
      assert(!c.requests.some(u=>u.includes('/topics/101/')),'known exclusions are not polled');
    } finally { c.close(); }
  });
  await test('automatic sync settings reject foreign requests and preserve status without disk permission',async()=>{
    const e=await connected({auto:true});
    const previous=await e.db.get('documentsStatus'); previous.lastUpdated=123; previous.summary={errors:['Existing error']}; await e.db.put('documentsStatus',previous);
    assert.equal((await e.send('set-auto',{auto:false},'hostile')).ok,false);
    assert.equal((await e.send('set-auto',{auto:'false'})).ok,false);
    assert.equal((await e.db.get('documentsConnection')).auto,true);
    e.d.state.permission='prompt'; assert.equal((await e.send('set-auto',{auto:false})).ok,true);
    const after=await e.db.get('documentsStatus'); assert.equal(after.auto,false); assert.deepEqual(after.summary,previous.summary); assert.equal(after.lastUpdated,123);
  });
  process.exit(process.exitCode||0);
})();
