import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve,dirname,posix} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const manifest=JSON.parse(await readFile(resolve(root,'package.json'),'utf8'));
const fileName=manifest.name.replace(/^@/,'').replaceAll('/','-')+'-'+manifest.version+'.tgz';
const archivePath=resolve(root,process.argv[2]||'artifacts/'+fileName);
const archive=await readFile(archivePath);
const tar=gunzipSync(archive,{maxOutputLength:32*1024*1024});
const entries=new Map();
const text=(buffer)=>buffer.toString('utf8').replace(/\0.*$/s,'');
for(let offset=0;offset+512<=tar.length;){
  const header=tar.subarray(offset,offset+512);
  if(header.every(byte=>byte===0))break;
  const recorded=Number.parseInt(text(header.subarray(148,156)).trim(),8);
  let checksum=0;
  for(let i=0;i<512;i++)checksum+=i>=148&&i<156?32:header[i];
  assert.equal(checksum,recorded,'Invalid tar header checksum');
  const size=Number.parseInt(text(header.subarray(124,136)).trim()||'0',8);
  assert.ok(Number.isSafeInteger(size)&&size>=0&&offset+512+size<=tar.length,'Invalid tar entry size');
  const prefix=text(header.subarray(345,500));
  const name=(prefix?prefix+'/':'')+text(header.subarray(0,100));
  assert.ok(name.startsWith('package/')&&!name.includes('\\')&&!name.split('/').includes('..'),'Unsafe archive path: '+name);
  const type=header[156];
  assert.ok(type===0||type===48||type===53,'Unexpected tar entry type (links/metadata are not allowed): '+name);
  if(type!==53){
    assert.ok(!entries.has(name),'Duplicate archive entry: '+name);
    const relative=name.slice('package/'.length);
    assert.ok(!/(?:^|\/)(?:node_modules|verification|design|artifacts|coverage|\.git|\.env(?:\..*)?|\.npmrc)(?:\/|$)/.test(relative),'Private/unnecessary file in archive: '+name);
    entries.set(name,tar.subarray(offset+512,offset+512+size));
  }
  offset+=512+Math.ceil(size/512)*512;
}
const required=['package.json','index.js','host.js','editor-core.js','client.js','client.editor.js','cordis.patch.yml','locale/en.json','locale/zh.json','icon.svg','README.md','LICENSE'];
for(const path of required)assert.ok(entries.has('package/'+path),'Missing runtime file: '+path);
// pnpm pack removes the repository-only packageManager field; all runtime metadata must match.
const {packageManager,...packedExpected}=manifest;
assert.deepEqual(JSON.parse(entries.get('package/package.json').toString('utf8')),packedExpected,'Packed runtime manifest differs from source');
for(const [name,contents] of entries){
  if(name==='package/package.json')continue;
  const local=await readFile(resolve(root,name.slice('package/'.length)));
  assert.ok(local.equals(contents),'Packed bytes differ from source: '+name);
}
for(const [name,contents] of entries){
  if(!name.endsWith('.md'))continue;
  for(const match of contents.toString('utf8').matchAll(/\]\((?:<([^>]+)>|([^\s)]+))\)/g)){
    const href=match[1]||match[2];
    if(/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(href))continue;
    const target=posix.normalize(posix.join(posix.dirname(name),decodeURIComponent(href.split('#')[0])));
    assert.ok(entries.has(target),'Broken packed documentation link: '+name+' -> '+href);
  }
}
const entry=entries.get('package/client.js').toString('utf8');
const editor=entries.get('package/client.editor.js').toString('utf8');
const moduleId=source=>source.match(/window\.__ModuleLoader__\.load\(\{\s*id:\s*['"]([^'"]+)['"]/)?.[1];
assert.equal(moduleId(entry),manifest.name);
assert.equal(moduleId(editor),manifest.name+'/client.editor.js');
assert.ok(entry.includes(createHash('sha256').update(editor).digest('hex')),'Entry must reference the exact packed lazy chunk');
assert.ok(entries.get('package/cordis.patch.yml').toString('utf8').includes("name: '"+manifest.name+"'"));
console.log(JSON.stringify({name:manifest.name,version:manifest.version,archive:fileName,files:entries.size,bytes:archive.length,sha256:createHash('sha256').update(archive).digest('hex'),checks:'runtime closure, public module identity, source byte parity, documentation links, no private artifacts or symlinks'},null,2));
