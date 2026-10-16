import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {smoke} from '../../scripts/protocol-smoke.mjs';
test('packaged stdio protocol initializes, lists documented tools and rejects malformed mutation requests',async()=>{
 const {tools,replies}=await smoke(resolve('dist/index.js'),'0.8.0',[
  {name:'scene_adjust_light',arguments:{entity_id:'light.test',state:'off',user_confirmed:'false'}},
  {name:'scene_adjust_light',arguments:{entity_id:'switch.heater',state:'off',user_confirmed:true}},
  {name:'scene_blackout',arguments:{user_confirmed:false}},
  {name:'nonexistent',arguments:{}},
 ]);
 for(let id=3;id<=6;id++){const r=replies.get(id);assert(r.error||r.result?.isError===true,'Invalid request must fail: '+id);}
 const read=tools.find(t=>t.name==='scene_show_lights');assert.equal(read.annotations?.readOnlyHint,true);
 for(const name of ['scene_delete','scene_blackout','scene_update'])assert.equal(tools.find(t=>t.name===name).annotations?.destructiveHint,true);
});
