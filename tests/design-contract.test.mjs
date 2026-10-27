import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const read=p=>readFile(new URL('../'+p,import.meta.url),'utf8');

// Source contracts only: these protect intent, not rendered layout or visual quality.
test('review desk keeps translations complete and describes the image hand-off',async()=>{
  const messages=JSON.parse(await read('src/messages.json'));
  assert.deepEqual(Object.keys(messages.en).sort(),Object.keys(messages.zh).sort());
  for(const lang of ['en','zh'])for(const key of ['workspace','workflow','stepMark','stepMove','stepSend','dropImage','sendIncludes'])assert.ok(messages[lang][key]);
  const view=await read('src/editor-view.js');
  assert.match(view,/className:'dif-source-info'/);
  assert.match(view,/className:'dif-summary'.*t\('sendIncludes'\)/);
  assert.match(view,/className:'dif-empty-steps','aria-label':t\('workflow'\)/);
  assert.match(view,/'aria-pressed':!!draft&&/);
});
test('asset selection predicate never marks history-only images selected in an empty desk',async()=>{
  const view=await read('src/editor-view.js');
  const expression=view.match(/'aria-pressed':(!!draft&&[^,]+),onClick:/)[1];
  const selected=Function('draft','a','return '+expression);
  assert.equal(selected(null,{attachmentId:'image-a'}),false);
  assert.equal(selected(null,{assetId:'asset-a'}),false);
  const draft={asset:{assetId:'asset-a',attachmentId:'image-a'}};
  assert.equal(selected(draft,{assetId:'asset-a'}),true);
  assert.equal(selected(draft,{attachmentId:'image-a'}),true);
  assert.equal(selected(draft,{attachmentId:'image-b'}),false);
});
test('short-panel focus reveals only within editor-owned scrollports',async()=>{
  const view=await read('src/editor-view.js');
  assert.match(view,/editorRef\.current\?\.focus\(\{preventScroll:true\}\);revealInEditor\(editorRef\.current\)/);
  assert.match(view,/confirmationRef\.current\?\.focus\(\{preventScroll:true\}\);revealInEditor\(confirmationRef\.current\)/);
  assert.match(view,/previous\?\.isConnected&&rootRef\.current\?\.contains\(previous\)/);
  assert.match(view,/\[notesScrollRef\.current,rootRef\.current\]/);
  assert.match(view,/className:'dif-notes-scroll',ref:notesScrollRef/);
  assert.doesNotMatch(view,/scrollIntoView|document\.body\.scroll/);
});
test('native sidebar responds to its own width and height without reducing labels to 9px',async()=>{
  const css=await read('src/editor.css'),view=await read('src/editor-view.js');
  assert.match(css,/container: dif-editor \/ inline-size/);
  for(const width of [290,360,440])assert.ok(css.includes(`@container dif-editor (max-width: ${width}px)`));
  assert.match(css,/\.dif-footer-actions[^}]*flex-wrap: wrap/);
  assert.match(css,/\.dif-source-info[^}]*min-width: 0/);
  assert.doesNotMatch(css,/font-size:\s*9px/);
  assert.match(css,/@media \(pointer: coarse\)/);
  assert.match(css,/@media \(forced-colors: active\)/);
  assert.match(view,/observer\.observe\(root\);return\(\)=>observer\.disconnect\(\)/);
  assert.match(css,/data-compact-height="true"/);
});
test('motion is limited to local reveals and control feedback, never canvas geometry',async()=>{
  const css=await read('src/editor.css');
  assert.match(css,/@media \(prefers-reduced-motion: reduce\)[\s\S]*animation: none; transition: none/);
  assert.doesNotMatch(css,/\binfinite\b|transition:\s*all/);
  const canvas=css.match(/\.dif-root \.dif-canvas \{([^}]+)\}/)[1];
  assert.doesNotMatch(canvas,/animation|transition/);
  const inspector=css.match(/\.dif-root \.dif-inspector:focus-within \{([^}]+)\}/)[1];
  assert.match(inspector,/border-color: var\(--dsw-alias-brand-primary\)/);
});
test('keyboard submission lock and path Escape precede history mutations',async()=>{
  const view=await read('src/editor-view.js');
  const key=view.slice(view.indexOf('function key('),view.indexOf('function removeBlock('));
  assert.match(key,/isComposing/);
  assert.ok(key.indexOf("event.key==='Escape'&&pathOpen")<key.indexOf("event.target.closest('textarea,input"));
  const history=view.slice(view.indexOf('function historyAction('),view.indexOf('function key('));
  assert.ok(history.indexOf('if(isLocked||confirmation||pointer.current)return;')<history.indexOf('c[direction]()'));
  assert.match(view,/onKeyDownCapture:shortcutKey/);
  assert.ok(key.indexOf('if(isLocked)return;')<key.indexOf('core.moveBlock'));
  assert.match(view,/dragDepth\.current=0;setFileHover\(false\)/);
  assert.match(view,/dropEffect=isLocked\?'none':'copy'/);
  assert.match(view,/pointerEvents:'none'/);
});
