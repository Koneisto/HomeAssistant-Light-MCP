import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm,readFile,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

test('real HTTP round trip preserves external scenes and owned recovery lifecycle',async()=>{
 const home=await realpath(await mkdtemp(join(tmpdir(),'ha-mcp-http-')));
 const previous={HOME:process.env.HOME,HA_URL:process.env.HA_URL,HA_TOKEN:process.env.HA_TOKEN};
 const light={entity_id:'light.lamp',state:'on',attributes:{friendly_name:'Fixture lamp',brightness:55,color_mode:'color_temp',color_temp_kelvin:2700,rgb_color:[255,166,80],supported_color_modes:['color_temp','rgb'],min_color_temp_kelvin:2000,max_color_temp_kelvin:6500}};
 const configs={external:{id:'external',name:'External',entities:{'light.lamp':{state:'on'},'switch.fan':'on'}}};const calls=[];
 const server=createServer(async(req,res)=>{
  assert.equal(req.headers.authorization,'Bearer integration-fixture');
  const body=[];for await(const part of req)body.push(part);const input=body.length?JSON.parse(Buffer.concat(body).toString()):null;
  calls.push({method:req.method,path:req.url,input});res.setHeader('content-type','application/json');
  const send=(value,status=200)=>{res.statusCode=status;res.end(JSON.stringify(value));};
  const sceneStates=()=>Object.values(configs).map(c=>({entity_id:'scene.'+c.id.replaceAll('-','_'),state:'fixture',attributes:{id:c.id,friendly_name:c.name,entity_id:Object.keys(c.entities)}}));
  if(req.url==='/api/states')return send([light,...sceneStates()]);
  if(req.url==='/api/states/light.lamp')return send(light);
  if(req.url.startsWith('/api/config/scene/config/')){
   const id=req.url.split('/').at(-1);
   if(req.method==='GET')return send(configs[id]||{},configs[id]?200:404);
   if(req.method==='POST'){configs[id]=input;return send({result:'ok'});}
   if(req.method==='DELETE'){delete configs[id];return send({result:'ok'});}
  }
  if(req.url==='/api/services/scene/reload')return send([]);
  if(req.url==='/api/template')return send('|||');
  return send({error:'unexpected fixture request'},404);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  process.env.HOME=home;process.env.HA_URL='http://127.0.0.1:'+server.address().port;process.env.HA_TOKEN='integration-fixture';
  const api=await import(pathToFileURL(join(process.cwd(),'dist/index.js')).href+'?http-fixture');
  const original=structuredClone(configs.external);
  let r=await api.dispatchTool('scene_fix',{action:'fix_all',dry_run:false,user_confirmed:true});assert(!r.isError,JSON.stringify(r));assert.deepEqual(configs.external,original);assert.equal(calls.filter(c=>c.method==='POST').length,0);
  r=await api.dispatchTool('scene_activate',{entity_id:'scene.external',user_confirmed:true});assert.equal(r.isError,true);assert.equal(calls.filter(c=>c.method==='POST').length,0);
  r=await api.dispatchTool('scene_create',{name:'Owned fixture',mode:'additive',user_confirmed:true});assert(!r.isError,JSON.stringify(r));
  const owned=Object.values(configs).find(c=>c.id!=='external');assert(owned);assert.equal(owned.entities['light.lamp'].color_temp_kelvin,2700);assert.equal(owned.entities['light.lamp'].rgb_color,undefined);
  light.attributes.brightness=89;
  r=await api.dispatchTool('scene_update',{entity_id:'scene.'+owned.id.replaceAll('-','_'),user_confirmed:true});assert(!r.isError,JSON.stringify(r));assert.equal(configs[owned.id].entities['light.lamp'].brightness,89);
  r=await api.dispatchTool('scene_delete',{entity_id:'scene.'+owned.id.replaceAll('-','_'),user_confirmed:true});assert(!r.isError,JSON.stringify(r));assert(!configs[owned.id]);
  r=await api.dispatchTool('scene_fix',{action:'restore_from_backup',scene_name:'Owned Fixture',dry_run:false,user_confirmed:true});assert(!r.isError,JSON.stringify(r));assert(configs[owned.id]);assert.deepEqual(configs.external,original);
  assert.equal(calls.filter(c=>/\/api\/services\/light\//.test(c.path)).length,0,'Scene lifecycle must not change light state');
 }finally{
  for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  await new Promise(resolve=>server.close(resolve));await rm(home,{recursive:true,force:true});
 }
});
