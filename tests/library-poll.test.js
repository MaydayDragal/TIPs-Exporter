const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {connected,content,until,tick,LI,TOPIC,pdf,ROOT}=require('./helpers/documents-env');
const modulePath=path.join(ROOT,'library-polling.js');
async function test(name,fn){let timer;try{await Promise.race([fn(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Test timed out')),20000);})]);console.log('PASS '+name);}catch(e){console.log('FAIL '+name+': '+e.stack);process.exitCode=1;}finally{clearTimeout(timer);}}
function event(){const listeners=[];return {addListener:fn=>listeners.push(fn),fire:async(...args)=>Promise.all(listeners.map(fn=>fn(...args))),listeners};}
function clockChrome(state={documentsFolder:{configured:true,auto:true,pollMinutes:10}}){
 let time=Date.now(),alarm,creates=0; const messages=[],tabs=[{id:1,url:'https://xentry.mercedes-benz.com/tips-reader/search/topics'}],handlers=new Map([[1,async m=>m.type==='library-poll-status'?{ready:true,busy:false}:{accepted:true}]]);
 const c={runtime:{id:'test-extension',onMessage:event(),onStartup:event(),onInstalled:event()},storage:{local:{get:async keys=>Object.fromEntries(keys.map(k=>[k,state[k]]))},onChanged:event()},
  alarms:{get:async()=>alarm,clear:async()=>{alarm=undefined;},create:async(name,info)=>{creates++;alarm={name,...info,scheduledTime:info.when??time+info.delayInMinutes*60000};},onAlarm:event()},
  tabs:{query:async()=>tabs,sendMessage:async(id,m)=>{messages.push({id,...m});return handlers.get(id)(m);}}};
 const folder={handle:{queryPermission:async()=> 'granted'}},db={get:async k=>k==='documentsConnection'?folder:null};
 return {c,state,db,tabs,handlers,messages,now:()=>time,advance:n=>{time+=n;},alarm:()=>alarm,creates:()=>creates};
}
(async()=>{
 await test('a repeating Chrome alarm defaults to ten minutes and survives worker reinitialization',async()=>{
  assert(fs.existsSync(modulePath),'background polling module exists'); const e=clockChrome();delete e.state.documentsFolder.pollMinutes;
  const P=require(modulePath),p=P.create({chrome:e.c,db:e.db,now:e.now});await p.reconcile();assert.equal(e.alarm().periodInMinutes,10);assert.equal(e.alarm().scheduledTime,e.now()+600000);
  const t=e.alarm().scheduledTime;await P.create({chrome:e.c,db:e.db,now:e.now}).reconcile();assert.equal(e.alarm().scheduledTime,t);assert.equal(e.creates(),1);
  await e.c.alarms.clear();await p.reconcile();assert.equal(e.alarm().periodInMinutes,10);
 });
 await test('interval edits reschedule the alarm while status changes do not postpone it',async()=>{
  assert(fs.existsSync(modulePath));const e=clockChrome(),p=require(modulePath).create({chrome:e.c,db:e.db,now:e.now});await p.reconcile();e.advance(5000);e.state.documentsFolder.pollMinutes=3;await p.reconcile();assert.equal(e.alarm().periodInMinutes,3);
  const at=e.alarm().scheduledTime;e.advance(1000);e.state.documentsFolder.message='Folder scanned';await p.reconcile();assert.equal(e.alarm().scheduledTime,at);
  e.state.documentsFolder.auto=false;await p.reconcile();assert.equal(e.alarm(),undefined);
  e.state.documentsFolder.auto=true;e.state.documentsFolder.pollMinutes=0;await p.reconcile();assert.equal(e.alarm().periodInMinutes,10);
 });
 await test('each alarm chooses one idle TIPS tab and skips overlapping or recently completed checks',async()=>{
  assert(fs.existsSync(modulePath));const e=clockChrome(),p=require(modulePath).create({chrome:e.c,db:e.db,now:e.now});
  e.tabs.push({id:2,url:e.tabs[0].url});e.handlers.set(2,e.handlers.get(1));await p.tick();assert.equal(e.messages.filter(m=>m.type==='library-poll').length,1);
  e.messages.length=0;e.handlers.set(1,async()=>({ready:false,busy:true}));await p.tick();assert.equal(e.messages.filter(m=>m.type==='library-poll').length,0);
  e.handlers.set(1,e.handlers.get(2));e.state.lastCheck={at:new Date(e.now()).toISOString()};await p.tick();assert.equal(e.messages.filter(m=>m.type==='library-poll').length,0);
  e.advance(600000);await p.tick();assert.equal(e.messages.filter(m=>m.type==='library-poll').length,1);
 });
 await test('alarms skip closed, logged-out, paused, and inaccessible folders without opening tabs',async()=>{
  assert(fs.existsSync(modulePath));const e=clockChrome(),p=require(modulePath).create({chrome:e.c,db:e.db,now:e.now});
  e.handlers.set(1,async()=>({ready:false,busy:false}));await p.tick();assert(!e.messages.some(m=>m.type==='library-poll'));
  e.handlers.set(1,async()=>({ready:true,busy:false}));e.db.get=async()=>({handle:{queryPermission:async()=> 'prompt'}});await p.tick();assert(!e.messages.some(m=>m.type==='library-poll'));
  e.state.documentsFolder.auto=false;await p.tick();e.tabs.length=0;await p.tick();assert(!e.messages.some(m=>m.type==='library-poll'));
 });
 await test('a tab that becomes busy after the status check does not cause a second tab to sync',async()=>{
  const e=clockChrome(),p=require(modulePath).create({chrome:e.c,db:e.db,now:e.now});let busy=false;
  e.tabs.push({id:2,url:e.tabs[0].url});
  e.handlers.set(1,async m=>{if(m.type==='library-poll-status')return {ready:true,busy:false};busy=true;return {accepted:false};});
  e.handlers.set(2,async m=>{if(m.type==='library-poll-status')return {ready:true,busy:false};assert.equal(busy,false,'must not start a second sync after the first tab becomes busy');return {accepted:true};});
  await p.tick();assert.deepEqual(e.messages.filter(m=>m.type==='library-poll').map(m=>m.id),[1]);
 });
 await test('native alarm, startup and settings listeners use the same scheduler',async()=>{
  assert(fs.existsSync(modulePath));const e=clockChrome(),p=require(modulePath).create({chrome:e.c,db:e.db,now:e.now});p.start();await until(()=>e.alarm());
  await e.c.alarms.onAlarm.fire({name:e.alarm().name});assert.equal(e.messages.filter(m=>m.type==='library-poll').length,1);
  e.state.documentsFolder.pollMinutes=4;await e.c.storage.onChanged.fire({documentsFolder:{newValue:e.state.documentsFolder}},'local');await until(()=>e.alarm().periodInMinutes===4);
  await e.c.alarms.clear();await e.c.runtime.onStartup.fire();await until(()=>e.alarm());assert.equal(e.alarm().periodInMinutes,4);
 });
 await test('Settings persists a validated polling interval and reflects it in Library',async()=>{
  const e=await connected({auto:true}),c=await content(e,undefined,{section:'library'});
  try{c.$('gear').click();assert(c.$('s_pollMinutes'),'Settings has interval input');assert.equal(c.$('s_pollMinutes').value,'10');
   c.$('s_pollMinutes').value='3';c.$('s_pollMinutes').dispatchEvent(new c.w.Event('input'));c.$('s_save').click();await until(()=>e.state.documentsFolder.pollMinutes===3);assert.equal((await e.db.get('documentsConnection')).pollMinutes,3);
   c.$('s_pollMinutes').value='0';c.$('s_save').click();await tick(40);assert.equal(e.state.documentsFolder.pollMinutes,3);assert.match(c.root().textContent,/1.*1440/);
   c.$('tolibrary').click();assert.match(c.$('library_panel').textContent,/every 3 minutes/);
  }finally{c.close();}
 });
 await test('scheduled sync uses real incremental downloads, preserves old files, and skips the second document fetch',async()=>{
  const e=await connected({auto:true}),c=await content(e,undefined,{section:'library'});
  try{const status=await e.tabs.get(1)({type:'library-poll-status'});assert.equal(status.ready,true);
   const result=await e.tabs.get(1)({type:'library-poll'});assert.equal(result.accepted,true);await until(()=>e.messages.some(m=>m.action==='end'));await until(()=>!c.$('library_sync').disabled);
   assert.equal(c.requests.filter(u=>u.includes('/search')).length,1);assert.equal(c.requests.filter(u=>u.includes('/file/topics/')).length,1);assert.equal(await e.d.read(`${TOPIC}/${LI}_v4.pdf`),pdf(4));
   c.requests.length=0;e.messages.length=0;await e.tabs.get(1)({type:'library-poll'});await until(()=>e.messages.some(m=>m.action==='end'));await until(()=>!c.$('library_sync').disabled);assert.equal(c.requests.length,1,'unchanged folder only needs the recent search');
  }finally{c.close();}
 });
 await test('expired sessions pause scheduled requests until a manual sync succeeds',async()=>{
  const e=await connected({auto:true});let expired=true;const c=await content(e,async(u,o)=>o?.method==='POST'&&expired?{ok:false,status:401}:null,{section:'library'});
  try{assert.equal((await e.tabs.get(1)({type:'library-poll'})).accepted,true);await until(()=>c.requests.length===1);await tick(60);
   assert.equal((await e.tabs.get(1)({type:'library-poll-status'})).ready,false);await e.tabs.get(1)({type:'library-poll'});assert.equal(c.requests.length,1);
   expired=false;c.$('library_sync').click();await until(()=>e.messages.some(m=>m.action==='end'));await until(()=>!c.$('library_sync').disabled);assert.equal((await e.tabs.get(1)({type:'library-poll-status'})).ready,true);
  }finally{c.close();}
 });
 await test('folder settings edits the same interval and rejects fractional minutes',async()=>{
  const e=await connected(), {JSDOM}=require('jsdom'),dom=new JSDOM(fs.readFileSync(path.join(ROOT,'folder-settings.html'),'utf8'),{url:'https://extension.test/',runScripts:'outside-only'}),w=dom.window,$=id=>w.document.getElementById(id);
  w.TIPSFolderDB=e.db;w.chrome={...e.chrome,runtime:{...e.chrome.runtime,sendMessage:m=>e.send(m.action,m,'options')}};
  w.eval(fs.readFileSync(path.join(ROOT,'documents-settings.js'),'utf8'));
  try{await until(()=>!$('save-documents').disabled);assert($('documents-poll-minutes'),'folder settings has interval');assert.equal($('documents-poll-minutes').value,'10');
   $('documents-poll-minutes').value='7';$('save-documents').click();await until(()=>e.state.documentsFolder.pollMinutes===7);await until(()=>!$('save-documents').disabled);
   $('documents-poll-minutes').value='2.5';$('save-documents').click();await until(()=>!$('save-documents').disabled);assert.equal(e.state.documentsFolder.pollMinutes,7);assert.match($('documents-result').textContent,/whole number/);
  }finally{dom.window.close();}
 });
 await test('poll interval messages reject foreign senders and invalid values without erasing status',async()=>{
  const e=await connected();const previous=await e.db.get('documentsStatus');previous.summary={errors:['keep this']};await e.db.put('documentsStatus',previous);
  assert.equal((await e.send('set-interval',{minutes:1},'hostile')).ok,false);
  for(const minutes of [0,-1,1.5,1441,'2'])assert.equal((await e.send('set-interval',{minutes})).ok,false);
  assert.deepEqual((await e.db.get('documentsStatus')).summary,previous.summary);assert.equal((await e.send('set-interval',{minutes:2})).ok,true);
 });
 await test('simultaneous timer events do not dispatch overlapping checks',async()=>{
  const e=clockChrome(),p=require(modulePath).create({chrome:e.c,db:e.db,now:e.now});let release;
  e.handlers.set(1,async m=>m.type==='library-poll-status'?new Promise(resolve=>{release=()=>resolve({ready:true,busy:false});}):{accepted:true});
  const first=p.tick();await until(()=>release);await p.tick();release();await first;
  assert.equal(e.messages.filter(m=>m.type==='library-poll').length,1);
 });
 process.exit(process.exitCode||0);
})();
