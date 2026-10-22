import test from 'node:test';
import assert from 'node:assert/strict';
import core from '../editor-core.js';
import {createSessionState} from '../src/session-state.js';
import {settleFeedbackText,promoteRegion,promoteSelectedRegion,movePointAnnotation,commitPointMove} from '../src/editor-intent.js';
const source={assetId:'a',attachmentId:'sha256:'+'a'.repeat(64),width:640,height:400};
const region={kind:'region',space:'layout',rect:{x:100,y:100,width:120,height:90}};
async function setup(t){
  let stored=core.createDraft({sessionId:'ui-lifecycle',asset:source}),version=0;
  const c=createSessionState({sessionId:'ui-lifecycle',core,delay:600000,recovery:{read:()=>null,write:()=>{},clear:()=>{}},rpc:async p=>{
    if(p.action==='loadDraft')return {draft:stored,version};
    if(p.action==='read')return {asset:{...source,url:'/synthetic-test'}};
    if(p.action==='saveDraft'){assert.equal(p.expectedVersion,version);stored=p.draft;return {version:++version};}
    throw new Error('Unexpected operation');
  }});t.after(()=>c.dispose());await c.ensureLoaded();return c;
}
function stage(c,text='',target=region){const next=core.addAnnotation(c.getSnapshot().draft,{text,target}),id=next.annotations.at(-1).id;c.beginTextEdit('note:'+id);c.previewText(next);return id;}
function seedMovedBlocks(c){
  let d=core.addBlock(c.getSnapshot().draft,{x:399,y:26,width:147,height:93},{id:'block-18'});
  d=core.moveBlock(d,'block-18',{x:14,y:7});
  d=core.addBlock(d,{x:71,y:228,width:139,height:78},{id:'block-23'});
  d=core.moveBlock(d,'block-23',{x:160,y:185});
  d=core.addAnnotation(d,{id:'note-1',text:'111',target:{kind:'region',space:'layout',rect:{x:45,y:51,width:153,height:96}}});
  d=core.addAnnotation(d,{id:'note-4',text:'444',target:{kind:'block',blockId:'block-18'}});
  d=core.validateDraft({...d,annotations:[d.annotations[0],{...d.annotations[1],number:4}],nextAnnotationNumber:5});
  c.commit(d);return c.getSnapshot().draft;
}

test('blur or unmount discards only a newly staged empty note, not earlier work',async t=>{
  const c=await setup(t);c.commit(core.addAnnotation(c.getSnapshot().draft,{text:'Keep this',target:{kind:'global'}}));
  const previous=c.getSnapshot().draft,id=stage(c);
  settleFeedbackText(core,c,id);
  assert.equal(c.getSnapshot().draft,previous);
  assert.equal(c.getSnapshot().history.undoCount,1);
  assert.equal(c.getTextEditKey(),null);
});
test('finishing a note trims once and preserves creation plus typing as a single undo',async t=>{
  const c=await setup(t),id=stage(c,'  A complete note  ');
  settleFeedbackText(core,c,id);
  assert.equal(c.getSnapshot().draft.annotations[0].text,'A complete note');
  assert.equal(c.getSnapshot().history.undoCount,1);
  c.undo();assert.equal(c.getSnapshot().draft.annotations.length,0);
});
test('blank region promotes directly to a block without losing its range or adding an empty note',async t=>{
  const c=await setup(t);c.commit(core.addAnnotation(c.getSnapshot().draft,{text:'Earlier work',target:{kind:'global'}}));
  const id=stage(c),result=promoteSelectedRegion(core,c,id),s=c.getSnapshot();
  assert.equal(result.noteId,null);
  assert.deepEqual(s.draft.blocks[0].source,region.rect);
  assert.equal(s.draft.annotations.length,1);
  assert.equal(s.draft.annotations[0].text,'Earlier work');
  assert.equal(s.history.undoCount,2);
  c.undo();assert.equal(c.getSnapshot().draft.blocks.length,0);assert.equal(c.getSnapshot().draft.annotations.length,1);
});
test('a rejected region move keeps the pending rectangle and earlier source unchanged',async t=>{
  const c=await setup(t);c.commit(core.addBlock(c.getSnapshot().draft,{x:120,y:120,width:40,height:40}));
  const id=stage(c),before=c.getSnapshot().draft;
  assert.throws(()=>promoteSelectedRegion(core,c,id,{x:300,y:30}),/overlaps/);
  assert.equal(c.getSnapshot().draft,before);
  assert.equal(c.getTextEditKey(),'note:'+id);
});
test('Undo routes the active blank transaction directly through history, never undoing an older edit too',async t=>{
  const c=await setup(t);c.commit(core.addAnnotation(c.getSnapshot().draft,{text:'Previous real change',target:{kind:'global'}}));
  stage(c);c.undo();
  assert.equal(c.getSnapshot().draft.annotations.length,1);
  assert.equal(c.getSnapshot().draft.annotations[0].text,'Previous real change');
  assert.equal(c.getSnapshot().history.undoCount,1);
});
test('promoting written feedback preserves its note identity, text and numbering',async t=>{
  const c=await setup(t),id=stage(c,'Move this card'),number=c.getSnapshot().draft.annotations[0].number;
  const result=promoteSelectedRegion(core,c,id),note=c.getSnapshot().draft.annotations[0];
  assert.equal(result.noteId,id);assert.equal(note.id,id);assert.equal(note.number,number);assert.equal(note.text,'Move this card');
  assert.equal(note.target.blockId,result.blockId);assert.equal(c.getTextEditKey(),null);
});

test('a fresh blank frame cuts and moves atomically without an empty annotation or intermediate undo',async t=>{
  const c=await setup(t);
  c.commit(core.addAnnotation(c.getSnapshot().draft,{text:'Keep earlier work',target:{kind:'global'}}));
  const baseline=c.getSnapshot().draft,undoBefore=c.getSnapshot().history.undoCount;
  const id=stage(c),result=promoteSelectedRegion(core,c,id,{x:260,y:180}),s=c.getSnapshot();
  assert.equal(result.draft,s.draft);
  assert.equal(result.noteId,null);
  assert.equal(s.draft.blocks[0].id,result.blockId);
  assert.deepEqual(s.draft.blocks[0].source,region.rect);
  assert.deepEqual(s.draft.blocks[0].destination,{x:260,y:180,width:120,height:90});
  assert.equal(s.draft.annotations.length,1);
  assert.equal(s.draft.annotations[0].text,'Keep earlier work');
  assert.equal(s.history.undoCount,undoBefore+1);
  assert.equal(c.getTextEditKey(),null);
  const moved=s.draft;
  c.undo();assert.equal(c.getSnapshot().draft,baseline);
  c.redo();assert.equal(c.getSnapshot().draft,moved);
});

test('moving a typed staged frame preserves text and finishes cut plus move in one following history step',async t=>{
  const c=await setup(t),id=stage(c,'  Move this specific card  ');
  const typed=c.getSnapshot().draft,original=typed.annotations[0];
  const result=promoteSelectedRegion(core,c,id,{x:350,y:160}),s=c.getSnapshot();
  assert.equal(result.noteId,id);
  assert.equal(s.draft.annotations[0].id,original.id);
  assert.equal(s.draft.annotations[0].number,original.number);
  assert.equal(s.draft.annotations[0].text,original.text);
  assert.deepEqual(s.draft.annotations[0].target,{kind:'block',blockId:result.blockId});
  assert.deepEqual(s.draft.blocks[0].source,region.rect);
  assert.deepEqual(s.draft.blocks[0].destination,{x:350,y:160,width:120,height:90});
  assert.equal(s.history.undoCount,2,'one completed text transaction, then one cut+move');
  c.undo();assert.equal(c.getSnapshot().draft,typed);
  assert.equal(c.getSnapshot().draft.blocks.length,0);
  c.undo();assert.equal(c.getSnapshot().draft.annotations.length,0);
});

test('moving an existing committed region keeps its original comment and adds only one undo entry',async t=>{
  const c=await setup(t);
  c.commit(core.addAnnotation(c.getSnapshot().draft,{text:'Existing feedback',target:region}));
  const baseline=c.getSnapshot().draft,id=baseline.annotations[0].id,undoBefore=c.getSnapshot().history.undoCount;
  const result=promoteSelectedRegion(core,c,id,{x:320,y:140});
  assert.equal(result.noteId,id);
  assert.equal(result.draft.annotations[0].text,'Existing feedback');
  assert.equal(result.draft.annotations[0].number,baseline.annotations[0].number);
  assert.equal(c.getSnapshot().history.undoCount,undoBefore+1);
  assert.deepEqual(core.resolveAnnotation(result.draft,id).layout.rect,{x:320,y:140,width:120,height:90});
  c.undo();assert.equal(c.getSnapshot().draft,baseline);
});

test('invalid move coordinates leave both blank and typed pending frames untouched',async t=>{
  for(const text of ['', 'Keep pending typing']){
    const c=await setup(t),id=stage(c,text),before=c.getSnapshot(),baseline=before.history.current;
    const positions=[{x:NaN,y:0},{x:Infinity,y:0},{x:0,y:-Infinity},{x:'12',y:0},{x:1},null];
    for(const destination of positions){
      assert.throws(()=>promoteSelectedRegion(core,c,id,destination),error=>error instanceof core.CoreError);
      assert.equal(c.getSnapshot(),before,'validation must precede any controller publication or settlement');
      assert.equal(c.getTextEditKey(),'note:'+id);
      assert.equal(c.getSnapshot().history.current,baseline);
      assert.equal(c.getSnapshot().history.undoCount,0);
      assert.equal(c.getSnapshot().draft.blocks.length,0);
      assert.equal(c.getSnapshot().draft.annotations[0].text,text);
    }
  }
});

test('direct region moves clamp to the fixed canvas without changing the source or size',async t=>{
  const c=await setup(t),id=stage(c);
  const result=promoteSelectedRegion(core,c,id,{x:-1000,y:1000}),block=result.draft.blocks[0];
  assert.deepEqual(block.source,region.rect);
  assert.deepEqual(block.destination,{x:0,y:310,width:120,height:90});
  assert.equal(result.draft.annotations.length,0);
  assert.equal(c.getSnapshot().history.undoCount,1);
  assert.equal(result.noteId,null);
});

test('pure moving-region previews do not mutate the controller, draft, history, or text transaction',async t=>{
  const c=await setup(t),id=stage(c),before=c.getSnapshot(),history=before.history;
  const serialized=core.serializeDraft(before.draft),baseline=history.current;
  const cut=promoteRegion(core,before.draft,id);
  const preview=core.moveBlock(cut.draft,cut.blockId,{x:999,y:-10},{bounds:'clamp'});
  assert.deepEqual(preview.blocks[0].destination,{x:520,y:0,width:120,height:90});
  assert.deepEqual(preview.blocks[0].source,region.rect);
  assert.equal(preview.annotations[0].id,id);
  assert.equal(preview.annotations[0].target.blockId,cut.blockId);
  assert.equal(c.getSnapshot(),before);
  assert.equal(core.serializeDraft(c.getSnapshot().draft),serialized);
  assert.equal(history.current,baseline);
  assert.equal(history.undoCount,0);
  assert.equal(history.version,0);
  assert.equal(c.getTextEditKey(),'note:'+id);
  assert.equal(before.draft.blocks.length,0);
});

test('written exact-destination feedback reuses block identity and keeps every older comment',async t=>{
  const c=await setup(t),baseline=seedMovedBlocks(c),old18=baseline.blocks[0],old23=baseline.blocks[1];
  const id=stage(c,'New instruction for the same component',{kind:'region',space:'layout',rect:old18.destination});
  const typed=c.getSnapshot().draft,newNote=typed.annotations.at(-1),result=promoteSelectedRegion(core,c,id,{x:290,y:140});
  assert.equal(result.blockId,'block-18');assert.equal(result.noteId,id);
  assert.equal(result.draft.blocks.length,2);
  assert.equal(result.draft.blocks[0].source,old18.source);
  assert.equal(result.draft.blocks[1],old23);
  assert.deepEqual(result.draft.blocks[0].destination,{x:290,y:140,width:147,height:93});
  assert.equal(result.draft.annotations[0],baseline.annotations[0]);
  assert.equal(result.draft.annotations[1],baseline.annotations[1]);
  const rebound=result.draft.annotations.find(note=>note.id===id);
  assert.equal(rebound.number,newNote.number);assert.equal(rebound.text,newNote.text);
  assert.deepEqual(rebound.target,{kind:'block',blockId:'block-18'});
  assert.equal(result.draft.annotations.length,baseline.annotations.length+1);
  c.undo();assert.equal(c.getSnapshot().draft,typed);
});

test('a fresh blank exact-destination frame drops only itself and moves the reused block atomically',async t=>{
  const c=await setup(t),baseline=seedMovedBlocks(c),undoBefore=c.getSnapshot().history.undoCount;
  const id=stage(c,'',{kind:'region',space:'layout',rect:baseline.blocks[0].destination});
  const result=promoteSelectedRegion(core,c,id,{x:88,y:60}),moved=result.draft;
  assert.equal(result.blockId,'block-18');assert.equal(result.noteId,null);
  assert.equal(moved.blocks.length,2);
  assert.equal(moved.blocks[0].source,baseline.blocks[0].source);
  assert.deepEqual(moved.blocks[0].destination,{x:88,y:60,width:147,height:93});
  assert.equal(moved.blocks[1],baseline.blocks[1]);
  assert.equal(moved.annotations,baseline.annotations);
  assert.equal(moved.annotations.find(note=>note.id==='note-4').text,'444');
  assert.equal(moved.annotations.find(note=>note.id==='note-4').number,4);
  assert.equal(c.getSnapshot().history.undoCount,undoBefore+1);
  assert.equal(c.getTextEditKey(),null);
  c.undo();assert.equal(c.getSnapshot().draft,baseline);
  c.redo();assert.equal(c.getSnapshot().draft,moved);
});

test('invalid moves of reused blocks are validated before cancelling a pending blank frame',async t=>{
  const c=await setup(t),baseline=seedMovedBlocks(c);
  const id=stage(c,'',{kind:'region',space:'layout',rect:baseline.blocks[0].destination}),before=c.getSnapshot();
  assert.throws(()=>promoteSelectedRegion(core,c,id,{x:NaN,y:20}),error=>error.code==='INVALID_NUMBER');
  assert.equal(c.getSnapshot(),before);
  assert.equal(c.getSnapshot().history.current,baseline);
  assert.equal(c.getTextEditKey(),'note:'+id);
  assert.equal(c.getSnapshot().draft.annotations[0],baseline.annotations[0]);
  assert.equal(c.getSnapshot().draft.annotations[1],baseline.annotations[1]);
  assert.equal(c.getSnapshot().draft.annotations.at(-1).target.kind,'region');
});

test('partial source-only overlap leaves pending text and both moved blocks untouched',async t=>{
  const c=await setup(t),baseline=seedMovedBlocks(c);
  const target={kind:'region',space:'layout',rect:{x:410,y:30,width:40,height:40}};
  const id=stage(c,'Preserve my rejected selection',target),before=c.getSnapshot();
  assert.equal(baseline.blocks.some(block=>core.rectanglesOverlap(target.rect,block.destination)),false);
  assert.throws(()=>promoteSelectedRegion(core,c,id,{x:300,y:180}),/already-owned source pixels/);
  assert.equal(c.getSnapshot(),before);
  assert.equal(c.getSnapshot().history.current,baseline);
  assert.equal(c.getTextEditKey(),'note:'+id);
  assert.equal(c.getSnapshot().draft.annotations.at(-1).text,'Preserve my rejected selection');
  assert.equal(c.getSnapshot().draft.blocks[0],baseline.blocks[0]);
  assert.equal(c.getSnapshot().draft.blocks[1],baseline.blocks[1]);
});

test('many free point previews remain pure and one committed gesture adds exactly one undo step',async t=>{
  const c=await setup(t);
  c.commit(core.addAnnotation(c.getSnapshot().draft,{text:'Move the marker only',target:{kind:'point',space:'layout',point:{x:20,y:30}}}));
  const baseline=c.getSnapshot().draft,id=baseline.annotations[0].id,history=c.getSnapshot().history,undoBefore=history.undoCount,snapshot=c.getSnapshot();
  for(let i=0;i<20;i++){
    const preview=movePointAnnotation(core,baseline,id,{x:80+i,y:70+i});
    assert.equal(preview.draft.blocks,baseline.blocks);
    assert.equal(c.getSnapshot(),snapshot);
    assert.equal(history.current,baseline);
    assert.equal(history.undoCount,undoBefore);
  }
  const result=commitPointMove(core,c,id,{x:99,y:89}),moved=c.getSnapshot().draft;
  assert.equal(result.draft,moved);assert.equal(result.noteId,id);assert.equal(Object.hasOwn(result,'blockId'),false);
  assert.deepEqual(moved.annotations[0].target.point,{x:99,y:89});
  assert.equal(moved.annotations[0].id,id);assert.equal(moved.annotations[0].number,baseline.annotations[0].number);
  assert.equal(moved.annotations[0].text,baseline.annotations[0].text);
  assert.equal(history.undoCount,undoBefore+1);
  assert.equal(c.getTextEditKey(),null);
  c.undo();assert.equal(c.getSnapshot().draft,baseline);
  c.redo();assert.equal(c.getSnapshot().draft,moved);
});

test('committing a local point gesture keeps the same block and old comments without moving pixels',async t=>{
  const c=await setup(t),original=seedMovedBlocks(c);
  c.commit(core.addAnnotation(c.getSnapshot().draft,{text:'Local marker',target:{kind:'block',blockId:'block-18',local:{kind:'point',point:{x:20,y:10}}}}));
  const baseline=c.getSnapshot().draft,id=baseline.annotations.at(-1).id,undoBefore=c.getSnapshot().history.undoCount;
  const result=commitPointMove(core,c,id,{x:999,y:-999});
  assert.equal(result.noteId,id);assert.equal(result.blockId,'block-18');
  assert.deepEqual(result.draft.annotations.at(-1).target,{kind:'block',blockId:'block-18',local:{kind:'point',point:{x:146,y:0}}});
  assert.equal(result.draft.blocks,baseline.blocks);
  assert.equal(result.draft.blocks[0].source,original.blocks[0].source);
  assert.equal(result.draft.annotations[0],original.annotations[0]);
  assert.equal(result.draft.annotations[1],original.annotations[1]);
  assert.equal(c.getSnapshot().history.undoCount,undoBefore+1);
  c.undo();assert.equal(c.getSnapshot().draft,baseline);
});

test('an existing point text edit and its move remain two distinct undo steps',async t=>{
  const c=await setup(t);
  c.commit(core.addAnnotation(c.getSnapshot().draft,{text:'Original text',target:{kind:'point',space:'layout',point:{x:20,y:30}}}));
  const baseline=c.getSnapshot().draft,id=baseline.annotations[0].id,undoBefore=c.getSnapshot().history.undoCount;
  c.beginTextEdit('note:'+id);
  c.previewText(core.updateAnnotation(c.getSnapshot().draft,id,{text:'Edited before moving'}));
  const typed=c.getSnapshot().draft;
  const result=commitPointMove(core,c,id,{x:200,y:150});
  assert.equal(result.draft.annotations[0].text,'Edited before moving');
  assert.deepEqual(result.draft.annotations[0].target.point,{x:200,y:150});
  assert.equal(c.getSnapshot().history.undoCount,undoBefore+2);
  assert.equal(c.getTextEditKey(),null);
  c.undo();assert.equal(c.getSnapshot().draft,typed);
  c.undo();assert.equal(c.getSnapshot().draft,baseline);
});

test('fresh blank point creation, movement, and following typing stay one pending undo group',async t=>{
  const c=await setup(t),baseline=c.getSnapshot().draft;
  const id=stage(c,'',{kind:'point',space:'layout',point:{x:20,y:30}}),key=c.getTextEditKey();
  const result=commitPointMove(core,c,id,{x:180,y:120});
  assert.equal(result.noteId,id);assert.equal(result.draft,c.getSnapshot().draft);
  assert.equal(c.getTextEditKey(),key);
  assert.equal(c.getSnapshot().history.current,baseline);
  assert.equal(c.getSnapshot().history.undoCount,0);
  assert.equal(c.getSnapshot().draft.annotations[0].text,'');
  assert.deepEqual(c.getSnapshot().draft.annotations[0].target.point,{x:180,y:120});
  for(const text of ['h','he','hel','hell','hello'])c.previewText(core.updateAnnotation(c.getSnapshot().draft,id,{text}));
  settleFeedbackText(core,c,id);
  const finished=c.getSnapshot().draft;
  assert.equal(c.getSnapshot().history.undoCount,1);
  assert.equal(finished.annotations[0].text,'hello');
  assert.deepEqual(finished.annotations[0].target.point,{x:180,y:120});
  c.undo();assert.equal(c.getSnapshot().draft,baseline);
  c.redo();assert.equal(c.getSnapshot().draft,finished);
});

test('Escape cancellation of a moved fresh blank free or local point removes only its pending group',async t=>{
  for(const local of [false,true]){
    const c=await setup(t);
    if(local)seedMovedBlocks(c);
    else c.commit(core.addAnnotation(c.getSnapshot().draft,{text:'Keep earlier feedback',target:{kind:'global'}}));
    const baseline=c.getSnapshot().draft,undoBefore=c.getSnapshot().history.undoCount;
    const target=local?{kind:'block',blockId:'block-18',local:{kind:'point',point:{x:20,y:10}}}:{kind:'point',space:'layout',point:{x:20,y:30}};
    const id=stage(c,'',target),result=commitPointMove(core,c,id,{x:80,y:70});
    assert.equal(result.blockId,local?'block-18':undefined);
    assert.equal(c.getTextEditKey(),'note:'+id);
    assert.equal(c.getSnapshot().history.undoCount,undoBefore);
    c.cancelTextEdit();
    assert.equal(c.getSnapshot().draft,baseline);
    assert.equal(c.getSnapshot().history.undoCount,undoBefore);
    assert.equal(c.getTextEditKey(),null);
  }
});

test('invalid point gesture validation never settles pending blank or written input',async t=>{
  for(const local of [false,true])for(const text of ['', 'Keep pending text']){
    const c=await setup(t);
    if(local)seedMovedBlocks(c);
    const target=local?{kind:'block',blockId:'block-18',local:{kind:'point',point:{x:20,y:10}}}:{kind:'point',space:'layout',point:{x:20,y:30}};
    const id=stage(c,text,target),before=c.getSnapshot(),baseline=before.history.current;
    for(const position of [{x:NaN,y:0},{x:0,y:Infinity},{x:-Infinity,y:0},{x:'10',y:20},null]){
      assert.throws(()=>commitPointMove(core,c,id,position),error=>error instanceof core.CoreError);
      assert.equal(c.getSnapshot(),before);
      assert.equal(c.getSnapshot().history.current,baseline);
      assert.equal(c.getTextEditKey(),'note:'+id);
      assert.equal(c.getSnapshot().draft.annotations.at(-1).text,text);
    }
  }
  const c=await setup(t),id=stage(c,'Not a point'),before=c.getSnapshot();
  assert.throws(()=>commitPointMove(core,c,id,{x:10,y:20}),/Only point annotations/);
  assert.equal(c.getSnapshot(),before);assert.equal(c.getTextEditKey(),'note:'+id);
});
