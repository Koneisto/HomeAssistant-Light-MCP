import assert from 'node:assert/strict';
import {readFileSync,existsSync,readdirSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {tools} from '../dist/index.js';
const files=['README.md','CHANGELOG.md','SECURITY.md',...readdirSync('docs').filter(p=>p.endsWith('.md')).map(p=>join('docs',p))];
for(const path of files){const text=readFileSync(path,'utf8');assert(text.length>250,'Documentation incomplete: '+path);for(const [,href] of text.matchAll(/\]\(([^)]+)\)/g)){if(/^(https?:|#|mailto:)/.test(href))continue;assert(existsSync(join(dirname(path),href.split('#')[0])),'Broken documentation link '+path+': '+href);}}
const readme=readFileSync('README.md','utf8');const rows=[...readme.matchAll(/^\| `(scene_[a-z_]+)` \|/gm)].map(m=>m[1]);assert.deepEqual([...rows].sort(),tools.map(t=>t.name).sort());
for(const needle of ['user_confirmed','dry_run','0.8.0','Node.js 22','partial','UPGRADING.md'])assert(readme.includes(needle),'Missing README contract '+needle);
assert(!/AI cannot change|Lights are safe|official.*can.t show/i.test(readme),'Overstated safety/feature comparison');
console.log('documentation verification passed');
