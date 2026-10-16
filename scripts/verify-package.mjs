import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {smoke} from './protocol-smoke.mjs';
const work=mkdtempSync(join(tmpdir(),'ha-mcp-package-'));const pkg=JSON.parse(readFileSync('package.json'));
function run(args,opts={}){const r=spawnSync('npm',args,{encoding:'utf8',...opts});assert.ifError(r.error);assert.equal(r.status,0,r.stderr||r.stdout);return r.stdout;}
try{
 run(['run','build']);
 const data=JSON.parse(run(['pack','--json','--ignore-scripts','--pack-destination',work]));const pack=Array.isArray(data)?data[0]:Object.values(data)[0];
 assert.equal(pack.version,pkg.version);const files=pack.files.map(f=>f.path);
 for(const path of ['dist/index.js','README.md','CHANGELOG.md','SECURITY.md','package.json','server.json'])assert(files.includes(path),'Missing '+path);
 for(const path of files)assert(!/(^|\/)(config\.json|scenes-backup\.json|\.env|\.npmrc|inventory|\.unlazy)(\/|$)/.test(path),'Private file packaged: '+path);
 const install=join(work,'clean-install');
 const installEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^npm_config_(allow_scripts|userconfig|globalconfig)$/i.test(key)));
 run(['install','--prefix',install,'--ignore-scripts','--omit=dev','--no-audit','--no-fund','--userconfig',join(work,'user.npmrc'),'--globalconfig',join(work,'global.npmrc'),join(work,pack.filename)],{env:installEnv});
 const cleanAudit=JSON.parse(run(['audit','--prefix',install,'--json','--userconfig',join(work,'user.npmrc'),'--globalconfig',join(work,'global.npmrc')],{env:installEnv}));
 assert.equal(cleanAudit.metadata.vulnerabilities.total,0,'Clean registry dependency resolution has advisories');
 const installed=join(install,'node_modules','ha-mcp-server');assert(existsSync(join(installed,'dist/index.js')));
 assert.equal(JSON.parse(readFileSync(join(installed,'package.json'))).version,pkg.version);
 await smoke(join(installed,'dist/index.js'),pkg.version);
 console.log('package verification passed');
}finally{rmSync(work,{recursive:true,force:true});}
