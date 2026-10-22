import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const read=p=>readFile(new URL('../'+p,import.meta.url),'utf8');
const luminance=hex=>hex.match(/\w\w/g).map(c=>parseInt(c,16)/255).map(c=>c<=.04045?c/12.92:((c+.055)/1.055)**2.4).reduce((n,c,i)=>n+c*[.2126,.7152,.0722][i],0);
const contrast=(a,b)=>(Math.max(luminance(a),luminance(b))+.05)/(Math.min(luminance(a),luminance(b))+.05);

test('primary-button CSS pairs primary text background with base-colored readable text, not a guessed on-brand color',async()=>{
  const css=await read('src/editor.css'),primary=css.match(/\.dif-root \.dif-btn\.dif-primary \{([^}]+)\}/)[1];
  assert.match(primary,/\n\s*color:\s*var\(--dsw-alias-bg-base\)/);
  assert.match(primary,/background:\s*var\(--dsw-alias-label-primary\)/);
  assert.doesNotMatch(primary,/light-dark|brand-primary/);
  assert.match(css,/\.dif-primary :where\(\.dif-tool-label, \.dif-icon\)\s*\{\s*color: inherit;/);
  assert.ok(contrast('f7f7f7','171717')>4.5);assert.ok(contrast('171717','ffffff')>4.5);
});
test('red image markup and white numbers use the same readable palette in the live SVG and exported reference',async()=>{
  const [css,view,adapter]=await Promise.all([read('src/editor.css'),read('src/editor-view.js'),read('src/editor.js')]);
  assert.match(css,/--dif-annotation:\s*#dc2626;/);assert.match(css,/--dif-annotation-ink:\s*#ffffff;/);
  assert.match(view,/stroke:'var\(--dif-annotation\)'/);assert.match(view,/fill:'var\(--dif-annotation-ink\)'/);
  assert.match(adapter,/accent='#dc2626',label='#ffffff'/);
  assert.ok(contrast('dc2626','ffffff')>=4.5);
});
test('single-tool view routes region drag through pure preview then one pointer-up commit and retains a text send label',async()=>{
  const view=await read('src/editor-view.js'),messages=JSON.parse(await read('src/messages.json'));
  assert.match(view,/\['select','point'\]\.map/);assert.doesNotMatch(view,/tool==='layout'|kind==='draw-block'/);
  const down=view.slice(view.indexOf('function down('),view.indexOf('function destination('));
  const move=view.slice(view.indexOf('function move('),view.indexOf('function cancelPointer('));
  const up=view.slice(view.indexOf('function up('),view.indexOf('function key('));
  assert.doesNotMatch(down,/promoteSelectedRegion|core\.addBlock/);
  assert.match(down,/visibleBlock=core\.hitTest\(now,p\)/);
  assert.match(down,/noteId:routedNoteId/);
  assert.match(down,/activeNote\?\.id!==noteId/);
  assert.match(down,/\[data-note-marker\]/);
  assert.match(move,/promoteRegion\(core,c\.getSnapshot\(\)\.draft,a\.noteId\)/);assert.doesNotMatch(move,/c\.commit/);
  assert.match(up,/promoteSelectedRegion\(core,c,a\.noteId,d\)/);
  assert.match(down,/noteLocalKind:note\?\.target\.local\?\.kind/);
  assert.match(move,/movePointAnnotation\(core,c\.getSnapshot\(\)\.draft,a\.noteId/);
  assert.match(up,/commitPointMove\(core,c,a\.noteId/);
  assert.match(view,/button\(state\.sending\?'sending':'send'/);
  assert.equal(messages.zh.send,'发送反馈');assert.ok(!('layout' in messages.zh));
});
