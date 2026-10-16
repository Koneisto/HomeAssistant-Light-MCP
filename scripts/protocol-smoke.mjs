import {spawn} from 'node:child_process';
import {mkdtemp,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
export async function smoke(entry, version='0.8.0', extraCalls=[]) {
 const home=await realpath(await mkdtemp(join(tmpdir(),'ha-mcp-smoke-')));
 const child=spawn(process.execPath,[entry],{env:{...process.env,HOME:home,USERPROFILE:home,HA_URL:'',HA_TOKEN:''},stdio:['pipe','pipe','pipe']});
 let stdout='',stderr='';const replies=new Map();
 const messages=[{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'package-verification',version:'1'}}},{jsonrpc:'2.0',method:'notifications/initialized'},{jsonrpc:'2.0',id:2,method:'tools/list'},...extraCalls.map((params,i)=>({jsonrpc:'2.0',id:i+3,method:'tools/call',params}))];
 try {
 await new Promise((resolve,reject)=>{
  const timeout=setTimeout(()=>{child.kill();reject(new Error('Protocol smoke timeout: '+stderr));},10000);
  child.on('error',reject);child.stderr.on('data',b=>stderr+=b);
  child.stdout.on('data',b=>{stdout+=b;let end;while((end=stdout.indexOf('\n'))>=0){let line=stdout.slice(0,end);stdout=stdout.slice(end+1);try{const m=JSON.parse(line);if(m.id!==undefined)replies.set(m.id,m);if(replies.size===messages.length-1){clearTimeout(timeout);resolve();}}catch(e){clearTimeout(timeout);reject(e);}}});
  child.on('exit',code=>{if(replies.size!==messages.length-1){clearTimeout(timeout);reject(new Error('Server exited '+code+': '+stderr));}});
  child.stdin.write(messages.map(x=>JSON.stringify(x)+'\n').join(''));
 });
 assert.equal(replies.get(1)?.result?.serverInfo?.version,version);
 const tools=replies.get(2)?.result?.tools;assert.equal(tools?.length,13);assert.equal(new Set(tools.map(t=>t.name)).size,13);
 for(const t of tools)assert(t.inputSchema&&t.name&&t.description,'Missing tool documentation/schema');
 return {tools,replies};
 }finally{child.stdin.end();child.kill();await rm(home,{recursive:true,force:true});}
}
