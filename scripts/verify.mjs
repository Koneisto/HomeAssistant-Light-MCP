import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const npmEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^npm_config_allow_scripts$/i.test(key)));
function run(args){const r=spawnSync('npm',args,{stdio:'inherit',env:npmEnv});assert.ifError(r.error);assert.equal(r.status,0,'npm '+args.join(' ')+' failed');}
run(['test']);
const docsHome=realpathSync(mkdtempSync(join(tmpdir(),'ha-mcp-docs-')));
try { const docs=spawnSync(process.execPath,['scripts/verify-docs.mjs'],{stdio:'inherit',env:{...process.env,HA_URL:'',HA_TOKEN:'',HOME:docsHome}});assert.ifError(docs.error);assert.equal(docs.status,0,'Documentation verification failed'); } finally {rmSync(docsHome,{recursive:true,force:true});}
const result=spawnSync('npm',['audit','--json'],{encoding:'utf8',env:npmEnv});
assert.ifError(result.error);
let audit;try{audit=JSON.parse(result.stdout);}catch{throw Error('npm audit did not return valid JSON');}
assert.equal(result.status,0,'Dependency security audit failed: '+JSON.stringify(audit.error || audit.metadata));assert.equal(audit.metadata.vulnerabilities.total,0,'Dependency advisories remain');
const pkg=JSON.parse(readFileSync('package.json'));const lock=JSON.parse(readFileSync('package-lock.json'));const registry=JSON.parse(readFileSync('server.json'));const mcp=JSON.parse(readFileSync('mcp.json'));
assert.equal(pkg.version,lock.version);assert.equal(pkg.version,lock.packages[''].version);assert.equal(pkg.version,registry.version);assert.equal(pkg.version,registry.packages[0].version);assert.equal(pkg.version,mcp.version);
assert.equal(pkg.engines.node,'>=22');assert(!pkg.devDependencies.ws);assert(!pkg.contributors,'Do not add invented contributors');
console.log('verification passed');
