import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BackupStorage, hashConfig, normalizedURL } from '../../dist/storage.js';

const originalFetch = globalThis.fetch;
const oldHome = process.env.HOME;
const oldURL = process.env.HA_URL;
const oldToken = process.env.HA_TOKEN;
const homes = [];
const light = (id = 'light.lamp', attributes = {}, state = 'on') => ({ entity_id: id, state, attributes: { friendly_name: id, supported_color_modes: ['rgb', 'color_temp'], min_color_temp_kelvin: 2000, max_color_temp_kelvin: 6500, ...attributes } });
const scene = (id = 'external', name = 'External') => ({ entity_id: `scene.${id.replaceAll("-", "_")}`, state: '2026-10-16', attributes: { id, friendly_name: name } });
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
async function setup(states = [light()], configs = {}) {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'ha-mcp-core-')); homes.push(home);
  process.env.HOME = home; process.env.HA_URL = 'http://ha.invalid:8123'; process.env.HA_TOKEN = 'unit-test-only';
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname; const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : undefined; calls.push({ path, method, body });
    if (path === '/api/states') return json(states);
    if (path.startsWith('/api/states/')) return states.find(s => s.entity_id === path.slice(12)) ? json(states.find(s => s.entity_id === path.slice(12))) : json({}, 404);
    if (path.startsWith('/api/config/scene/config/')) {
      const id = path.split('/').at(-1);
      if (method === 'GET') return configs[id] ? json(configs[id]) : json({}, 404);
      if (method === 'POST') { configs[id] = body; if (!states.some(s => s.attributes.id === id)) states.push(scene(id, body.name)); return json({}); }
      if (method === 'DELETE') { delete configs[id]; return json({}); }
    }
    if (path === '/api/template') return new Response('|||');
    if (path.startsWith('/api/services/')) return json([]);
    if (path === '/api/') return json({ message: 'API running.' });
    throw new Error(`Unexpected fake request ${path}`);
  };
  const api = await import(`${pathToFileURL(join(process.cwd(), 'dist/index.js')).href}?test=${homes.length}`);
  return { api, calls, home, states, configs, root: join(home, '.config/ha-mcp-server'), text: r => r.content[0].text };
}
test.after(() => { globalThis.fetch = originalFetch; if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; if (oldURL === undefined) delete process.env.HA_URL; else process.env.HA_URL = oldURL; if (oldToken === undefined) delete process.env.HA_TOKEN; else process.env.HA_TOKEN = oldToken; homes.forEach(home => rmSync(home, { recursive: true, force: true })); });

test('recursive hash tracks brightness, colors and nested keys; ignores key ordering', () => {
  assert.notEqual(hashConfig({ 'light.a': { brightness: 1 } }), hashConfig({ 'light.a': { brightness: 255 } }));
  assert.notEqual(hashConfig({ 'light.a': { rgb_color: [1,2,3] } }), hashConfig({ 'light.a': { rgb_color: [1,2,4] } }));
  assert.equal(hashConfig({ b: { z: 1, a: 2 }, a: 0 }), hashConfig({ a: 0, b: { a: 2, z: 1 } }));
});
test('all mutation schemas require real confirmation and reject unknown fields/types before API', async () => {
  const { api, calls } = await setup();
  const samples = [ ['scene_adjust_light', {entity_id:'light.lamp'}], ['scene_activate',{entity_id:'scene.external'}], ['scene_create',{name:'One',mode:'additive'}], ['scene_update',{entity_id:'scene.external'}], ['scene_delete',{entity_id:'scene.external'}], ['scene_blackout',{}], ['scene_sync',{}], ['scene_fix',{action:'fix_all'}], ['scene_configure',{url:'http://ha.invalid',token:'x'}] ];
  for (const [name, args] of samples) for (const user_confirmed of [undefined, false, 'false', 'true', 1, null]) assert.equal((await api.dispatchTool(name, { ...args, ...(user_confirmed === undefined ? {} : {user_confirmed}) })).isError, true, name);
  assert.equal((await api.dispatchTool('scene_diagnose', { test_connectivity:true })).isError,true);
  assert.equal((await api.dispatchTool('scene_list', { surprise:true })).isError,true);
  assert.equal(calls.length,0);
  assert.equal(api.tools.length,13);
  assert.equal(api.tools.find(t=>t.name==='scene_delete').annotations.destructiveHint,true);
});
test('light arguments reject wrong domains, nonfinite/out of range/conflicting inputs without API', async () => {
  const { api, calls } = await setup();
  for (const args of [{entity_id:'switch.heater'},{brightness:-1},{brightness:1.5},{brightness_pct:101},{brightness:1,brightness_pct:2},{rgb_color:[256,0,0]},{rgb_color:[1.2,0,0]},{rgb_color:[0,0]},{color_temp_kelvin:NaN},{rgb_color:[0,0,0],color_temp_kelvin:3000},{state:'off',brightness:100},{state:'toggle'}]) assert.equal((await api.dispatchTool('scene_adjust_light',{entity_id:'light.lamp',user_confirmed:true,...args})).isError,true);
  assert.equal(calls.length,0);
});
test('Kelvin validates target capabilities and actual device bounds before light write',async()=>{
  const { api,calls } = await setup();
  assert.equal((await api.dispatchTool('scene_adjust_light',{entity_id:'light.lamp',color_temp_kelvin:1000,user_confirmed:true})).isError,true);
  assert.equal((await api.dispatchTool('scene_adjust_light',{entity_id:'light.missing',state:'off',user_confirmed:true})).isError,true);
  assert.equal(calls.filter(c=>c.path.startsWith('/api/services/')).length,0);
});
test('fix never writes external/mixed scenes, and does not claim them through sync',async()=>{
  const mixed = {id:'external',name:'External',entities:{'light.lamp':{state:'on',brightness:null},'switch.heater':'on'},metadata:{mode:'exclusive'}};
  const { api,calls,configs } = await setup([light(),scene()],{external:structuredClone(mixed)});
  for (const name of ['scene_delete','scene_update']) assert.equal((await api.dispatchTool(name,{entity_id:'scene.external',user_confirmed:true})).isError,true);
  const fixed = await api.dispatchTool('scene_fix',{action:'fix_all',dry_run:false,user_confirmed:true}); assert.match(fixed.content[0].text,/Skipped external/);
  await api.dispatchTool('scene_sync',{user_confirmed:true});
  assert.deepEqual(configs.external,mixed);
  assert.equal(calls.filter(c=>c.method!=='GET').length,0);
});
test('unreadable and mixed scenes cannot activate; no scene.turn_on fallback',async()=>{
  for (const entities of [null, {'light.lamp':'on','switch.heater':'on'}]) {
    const {api,calls}=await setup([light(),scene()],entities?{external:{id:'external',name:'External',entities}}:{});
    assert.equal((await api.dispatchTool('scene_activate',{entity_id:'scene.external',user_confirmed:true})).isError,true);
    assert.equal(calls.filter(c=>c.path.startsWith('/api/services/')).length,0);
  }
});
test('external light-only scene activation is additive and respects active white color mode',async()=>{
  const {api,calls}=await setup([light(),light('light.other'),scene()],{external:{id:'external',name:'External',entities:{'light.lamp':{state:'on',color_mode:'color_temp',color_temp:250,rgb_color:[1,2,3],brightness:123,effect:'off'}},metadata:{mode:'exclusive',dynamicBlackout:true}}});
  const result=await api.dispatchTool('scene_activate',{entity_id:'scene.external',user_confirmed:true}); assert.equal(result.isError,undefined,result.content[0].text);
  const writes=calls.filter(c=>c.path.startsWith('/api/services/light/')); assert.equal(writes.length,1); assert.equal(writes[0].body.entity_id,'light.lamp'); assert.equal(writes[0].body.color_temp_kelvin,4000); assert.equal(writes[0].body.brightness,123); assert.equal(writes[0].body.effect,'off'); assert.equal(writes[0].body.color_temp,undefined); assert.equal(writes[0].body.rgb_color,undefined);
});
test('owned activation prefers current HA nested values over stale backup; validates all lights first',async()=>{
  const f=await setup([light(),light('light.second')]);
  await f.api.dispatchTool('scene_create',{name:'Owned',mode:'exclusive',user_confirmed:true}); const id=Object.keys(f.configs)[0];
  f.configs[id].entities['light.lamp'].brightness=17;
  f.configs[id].entities['light.second'].color_temp_kelvin=999999;
  f.calls.length=0;
  assert.equal((await f.api.dispatchTool('scene_activate',{entity_id:`scene.${id.replaceAll("-", "_")}`,user_confirmed:true})).isError,true);
  assert.equal(f.calls.filter(c=>c.path.startsWith('/api/services/')).length,0);
  delete f.configs[id].entities['light.second'].color_temp_kelvin;
  await f.api.dispatchTool('scene_activate',{entity_id:`scene.${id.replaceAll("-", "_")}`,user_confirmed:true});
  assert.equal(f.calls.find(c=>c.path.endsWith('light/turn_on')&&c.body.entity_id==='light.lamp').body.brightness,17);
});
test('dynamic blackout metadata survives creation, sync, backup fallback and new lights',async()=>{
  const f=await setup();
  const created=await f.api.dispatchTool('scene_blackout',{create_scene:true,user_confirmed:true}); assert.equal(created.isError,undefined,created.content[0].text);
  const id=Object.keys(f.configs)[0]; f.states.push(light('light.new'));
  f.calls.length=0;
  await f.api.dispatchTool('scene_sync',{user_confirmed:true});
  const storage=new BackupStorage(f.root,'http://ha.invalid:8123',()=>{}); assert.equal(storage.read().scenes[id].dynamicBlackout,true);
  let activated=await f.api.dispatchTool('scene_activate',{entity_id:`scene.${id.replaceAll("-", "_")}`,user_confirmed:true}); assert.equal(activated.isError,undefined,activated.content[0].text);
  assert.deepEqual(f.calls.find(c=>c.path.endsWith('/light/turn_off')).body.entity_id,['light.lamp','light.new']);
  f.states.splice(f.states.findIndex(s=>s.attributes.id===id),1); f.calls.length=0;
  activated=await f.api.dispatchTool('scene_activate',{entity_id:'scene.blackout',user_confirmed:true}); assert.equal(activated.isError,undefined);
  assert.deepEqual(f.calls.find(c=>c.path.endsWith('/light/turn_off')).body.entity_id,['light.lamp','light.new']);
});
test('import is preview first, copies lights to fresh ID, never edits mixed original',async()=>{
  const original={id:'external',name:'External',entities:{'light.lamp':{state:'on',color_temp:250,color_mode:'color_temp'},'switch.heater':'on'}};
  const f=await setup([light(),scene()],{external:structuredClone(original)});
  let r=await f.api.dispatchTool('scene_fix',{action:'import_scene',scene_name:'External',user_confirmed:true}); assert.match(r.content[0].text,/PREVIEW/); assert.deepEqual(Object.keys(f.configs),['external']);
  r=await f.api.dispatchTool('scene_fix',{action:'import_scene',scene_name:'External',dry_run:false,user_confirmed:true}); assert.equal(r.isError,undefined,r.content[0].text);
  assert.deepEqual(f.configs.external,original); const copy=Object.values(f.configs).find(s=>s.id!=='external'); assert.ok(copy); assert.deepEqual(Object.keys(copy.entities),['light.lamp']); assert.equal(copy.entities['light.lamp'].color_temp_kelvin,4000);
});
test('legacy unscoped backup is ignored until explicitly selected and copied; file remains unchanged',async()=>{
  const f=await setup(); mkdirSync(f.root,{recursive:true}); const old={version:1,scenes:{old:{name:'Old',mode:'additive',entities:{'light.lamp':{state:'on',color_temp:200},'switch.heater':'on'}}}}; const file=join(f.root,'scenes-backup.json'); writeFileSync(file,JSON.stringify(old));
  await f.api.dispatchTool('scene_sync',{user_confirmed:true}); assert.equal(Object.keys(f.configs).length,0);
  const r=await f.api.dispatchTool('scene_fix',{action:'migrate_legacy',scene_name:'Old',dry_run:false,user_confirmed:true}); assert.equal(r.isError,undefined,r.content[0].text);
  assert.deepEqual(JSON.parse(readFileSync(file,'utf8')),old); assert.ok(!f.configs.old); const copy=Object.values(f.configs)[0]; assert.equal(copy.entities['light.lamp'].color_temp_kelvin,5000); assert.equal(copy.entities['switch.heater'],undefined);
});
test('delete keeps restorable backup and snapshot; restore never overwrites existing HA scene',async()=>{
  const f=await setup(); await f.api.dispatchTool('scene_create',{name:'Owned',mode:'additive',user_confirmed:true}); const id=Object.keys(f.configs)[0];
  const r=await f.api.dispatchTool('scene_delete',{entity_id:`scene.${id.replaceAll("-", "_")}`,user_confirmed:true}); assert.equal(r.isError,undefined,r.content[0].text);
  const store=new BackupStorage(f.root,'http://ha.invalid:8123',()=>{}).read(); assert.ok(store.scenes[id]); assert.equal(store.snapshots[0].operation,'delete');
  await f.api.dispatchTool('scene_fix',{action:'restore_from_backup',scene_name:'Owned',dry_run:false,user_confirmed:true}); assert.ok(f.configs[id]);
  f.calls.length=0; await f.api.dispatchTool('scene_fix',{action:'restore_from_backup',scene_name:'Owned',dry_run:false,user_confirmed:true}); assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
});
test('service timeout actually aborts and never retries or reports success',async()=>{
  const {api}=await setup(); let calls=0; let aborted=0;
  globalThis.fetch=async(_url,options)=>{calls++;return new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>{aborted++;reject(new DOMException('aborted','AbortError'));},{once:true}));};
  await assert.rejects(api.callService('light','turn_off',{entity_id:'light.lamp'},20),/outcome uncertain/);
  await new Promise(r=>setTimeout(r,60)); assert.equal(calls,1); assert.equal(aborted,1);
  await assert.rejects(api.callService('scene','turn_on',{entity_id:'scene.test'}),/Only explicit/);
  await assert.rejects(api.callService('light','turn_off',{entity_id:'switch.heater'}),/Invalid entity/);
});
test('write 5xx/network failure is never retried, and stalled response bodies abort',async()=>{
  const {api}=await setup(); let calls=0;
  globalThis.fetch=async()=>{calls++;return json({},503);}; await assert.rejects(api.callService('light','turn_on',{entity_id:'light.lamp'},100),/503/); assert.equal(calls,1);
  calls=0; globalThis.fetch=async()=>{calls++;throw new Error('network');}; await assert.rejects(api.callService('light','turn_on',{entity_id:'light.lamp'},100),/outcome uncertain/); assert.equal(calls,1);
  calls=0; globalThis.fetch=async(_url,{signal})=>{calls++;return new Response(new ReadableStream({start(controller){signal.addEventListener('abort',()=>controller.error(new Error('aborted')),{once:true});}}));};
  await assert.rejects(api.callService('light','turn_off',{entity_id:'light.lamp'},20),/outcome uncertain/); assert.equal(calls,1);
});
test('read cancellation stops retry backoff without issuing a second request',async()=>{
  const {api}=await setup(); let calls=0; globalThis.fetch=async()=>{calls++;return json({},503);};
  await assert.rejects(api.haFetch('/api/states',{},20),/cancelled/); assert.equal(calls,1);
});
test('backup isolation, permissions, transaction locks, corrupt JSON and wrong-instance fail closed',()=>{
  const root=mkdtempSync(join(realpathSync(tmpdir()),'ha-mcp-store-')); homes.push(root);
  const validate=data=>{assert.equal(data.version,2);assert.equal(typeof data.instance,'string');};
  const a=new BackupStorage(root,'http://one.invalid/',validate),same=new BackupStorage(root,'http://one.invalid',validate),b=new BackupStorage(root,'http://two.invalid',validate);
  assert.equal(a.file,same.file); assert.notEqual(a.file,b.file);
  a.transaction(store=>{store.scenes.one={value:1};}); same.transaction(store=>{store.scenes.two={value:2};});
  assert.equal(Object.keys(a.read().scenes).length,2); assert.equal(Object.keys(b.read().scenes).length,0); assert.equal(statSync(a.file).mode&0o777,0o600); assert.equal(statSync(join(root,'instances',a.instance)).mode&0o777,0o700);
  const before=readFileSync(a.file,'utf8'); writeFileSync(`${a.file}.lock`,'busy'); assert.throws(()=>a.transaction(store=>{store.scenes={};}),/locked/); assert.equal(readFileSync(a.file,'utf8'),before); rmSync(`${a.file}.lock`);
  assert.throws(()=>a.transaction(()=>{throw new Error('disk simulation before commit');}),/simulation/); assert.equal(readFileSync(a.file,'utf8'),before);
  writeFileSync(a.file,'{broken'); assert.throws(()=>a.transaction(store=>{store.scenes={};}),/corrupt/); assert.equal(readFileSync(a.file,'utf8'),'{broken'); assert.equal(existsSync(`${a.file}.lock`),false);
  writeFileSync(a.file,JSON.stringify({...JSON.parse(before),instance:b.instance})); assert.throws(()=>a.read(),/another Home Assistant/);
  assert.throws(()=>normalizedURL('http://user:secret@one.invalid'),/without credentials/);
});

test('test_scene previews by default, explicit dry_run false performs activation',async()=>{
  const f=await setup([light(),scene()],{external:{id:'external',name:'External',entities:{'light.lamp':'on'}}});
  let r=await f.api.dispatchTool('scene_fix',{action:'test_scene',scene_name:'External',user_confirmed:true}); assert.match(r.content[0].text,/PREVIEW/); assert.equal(f.calls.filter(c=>c.path.startsWith('/api/services/')).length,0);
  r=await f.api.dispatchTool('scene_fix',{action:'test_scene',scene_name:'External',dry_run:false,user_confirmed:true}); assert.equal(r.isError,undefined,r.content[0].text); assert.ok(f.calls.some(c=>c.path.endsWith('/light/turn_on')));
});
test('changed HA metadata is synchronized without changes to nested light config',async()=>{
  const f=await setup(); await f.api.dispatchTool('scene_create',{name:'Owned',mode:'additive',user_confirmed:true}); const id=Object.keys(f.configs)[0];
  f.configs[id].name='Renamed'; f.configs[id].metadata.mode='exclusive';
  const r=await f.api.dispatchTool('scene_sync',{user_confirmed:true}); assert.equal(r.isError,undefined);
  const store=new BackupStorage(f.root,'http://ha.invalid:8123',()=>{}).read(); assert.equal(store.scenes[id].name,'Renamed'); assert.equal(store.scenes[id].mode,'exclusive');
});
test('external all-light scene containing unavailable targets fails before switching other lights',async()=>{
  const f=await setup([light(),light('light.unavailable',{},'unavailable'),scene()],{external:{id:'external',name:'External',entities:{'light.lamp':'on','light.unavailable':'on'}}});
  const r=await f.api.dispatchTool('scene_activate',{entity_id:'scene.external',user_confirmed:true}); assert.equal(r.isError,true); assert.equal(f.calls.filter(c=>c.path.startsWith('/api/services/')).length,0);
});
test('source permission policy rejects symlink ancestors before creating instance directory',async()=>{
  const {symlinkSync}=await import('node:fs');
  const root=mkdtempSync(join(realpathSync(tmpdir()),'ha-mcp-links-')); homes.push(root); const real=join(root,'real');mkdirSync(real);symlinkSync(real,join(root,'alias'),'dir');
  const store=new BackupStorage(join(root,'alias','config'),'http://ha.invalid',()=>{});
  assert.throws(()=>store.transaction(()=>{}),/Unsafe configuration directory ancestor/); assert.equal(existsSync(join(real,'config')),false);
});
test('real HTTP timeout closes an in-flight service request; redirects do not receive credentials',async()=>{
  const { createServer }=await import('node:http');
  let writes=0; let closed=0; let redirected=0;
  const sink=createServer((_req,res)=>{redirected++;res.end('{}');}); await new Promise(r=>sink.listen(0,'127.0.0.1',r));
  const source=createServer((req,res)=>{
    if(req.url==='/api/redirect'){res.writeHead(302,{location:`http://127.0.0.1:${sink.address().port}/steal`});res.end();return;}
    writes++; req.on('close',()=>closed++); // Never return a response.
  });await new Promise(r=>source.listen(0,'127.0.0.1',r));
  try{
    const home=mkdtempSync(join(realpathSync(tmpdir()),'ha-mcp-http-'));homes.push(home);process.env.HOME=home;process.env.HA_URL=`http://127.0.0.1:${source.address().port}`;process.env.HA_TOKEN='test-not-secret';globalThis.fetch=originalFetch;
    const api=await import(`${pathToFileURL(join(process.cwd(),'dist/index.js')).href}?real-http=${homes.length}`);
    await assert.rejects(api.callService('light','turn_off',{entity_id:'light.lamp'},150),/outcome uncertain/);
    await new Promise(r=>setTimeout(r,40));assert.equal(writes,1);assert.equal(closed,1);
    await assert.rejects(api.haFetch('/api/redirect',{method:'POST'},100),/outcome uncertain/);assert.equal(redirected,0);
  }finally{source.closeAllConnections();sink.closeAllConnections();await Promise.all([new Promise(r=>source.close(r)),new Promise(r=>sink.close(r))]);}
});

test('atomic serialization failure preserves last valid backup and removes temporary/lock files',async()=>{
  const {readdirSync}=await import('node:fs');
  const root=mkdtempSync(join(realpathSync(tmpdir()),'ha-mcp-failure-'));homes.push(root);const store=new BackupStorage(root,'http://ha.invalid',()=>{});
  store.transaction(value=>{value.scenes.one={ok:true};});const before=readFileSync(store.file,'utf8');
  assert.throws(()=>store.transaction(value=>{value.scenes.two={unserializable:1n};}),/BigInt/);
  assert.equal(readFileSync(store.file,'utf8'),before);assert.deepEqual(readdirSync(join(root,'instances',store.instance)),['scenes-backup.json']);
});
test('independent processes serialize complete backup transactions without lost scenes',async()=>{
  const {spawn}=await import('node:child_process');
  const root=mkdtempSync(join(realpathSync(tmpdir()),'ha-mcp-writers-'));homes.push(root);
  const script=`import {BackupStorage} from ${JSON.stringify(pathToFileURL(join(process.cwd(),'dist/storage.js')).href)};const store=new BackupStorage(process.argv[1],'http://ha.invalid',()=>{});for(let i=0;i<10;i++){let done=false;for(let attempt=0;attempt<100;attempt++){try{store.transaction(s=>{s.scenes[process.argv[2]+'-'+i]={value:i};});done=true;break;}catch(e){if(!e.message.includes('locked'))throw e;await new Promise(r=>setTimeout(r,5));}}if(!done)throw new Error('lock retry exhausted');}`;
  const run=label=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--input-type=module','-e',script,root,label],{stdio:['ignore','ignore','pipe']});let error='';child.stderr.on('data',data=>error+=data);child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(error||`writer exit ${code}`)));});
  await Promise.all([run('a'),run('b'),run('c')]);
  const store=new BackupStorage(root,'http://ha.invalid',()=>{});assert.equal(Object.keys(store.read().scenes).length,30);
});

test('partial environment credentials fail closed; prototype scene IDs cannot claim ownership',async()=>{
  const f=await setup();delete process.env.HA_TOKEN;
  await assert.rejects(import(`${pathToFileURL(join(process.cwd(),'dist/index.js')).href}?partial=${homes.length}`),/supplied together/);process.env.HA_TOKEN='unit-test-only';
  f.states.push(scene('constructor','Constructor'));f.configs.constructor={id:'constructor',name:'Constructor',entities:{'light.lamp':'on'},metadata:{dynamicBlackout:true,mode:'exclusive'}};
  const r=await f.api.dispatchTool('scene_activate',{entity_id:'scene.constructor',user_confirmed:true});assert.equal(r.isError,undefined,r.content[0].text);
  assert.equal(f.calls.filter(c=>c.path.endsWith('/light/turn_off')).length,0);assert.equal(f.calls.filter(c=>c.path.endsWith('/light/turn_on')).length,1);
});
