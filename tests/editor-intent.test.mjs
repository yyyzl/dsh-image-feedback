import test from 'node:test';
import assert from 'node:assert/strict';
import core from '../editor-core.js';
import {selectionIntent,selectionRectangle,promoteRegion,blockComment,writeBlockComment,settleFeedbackText,promoteSelectedRegion,movePointAnnotation,commitPointMove} from '../src/editor-intent.js';
import {createSessionState} from '../src/session-state.js';
const fresh=()=>core.createDraft({sessionId:'intent-test',asset:{assetId:'fixture',attachmentId:'sha256:'+'a'.repeat(64),width:640,height:400}});
// Supplied saved geometry, with synthetic asset/session identities; never accesses user storage.
function savedGeometry(){
  return core.validateDraft({...fresh(),revision:27,blocks:[
    {id:'block-18',source:{x:399,y:26,width:147,height:93},destination:{x:14,y:7,width:147,height:93},zIndex:0},
    {id:'block-23',source:{x:71,y:228,width:139,height:78},destination:{x:160,y:185,width:139,height:78},zIndex:1}
  ],annotations:[
    {id:'note-1',number:1,text:'111',target:{kind:'region',space:'layout',rect:{x:45,y:51,width:153,height:96}}},
    {id:'note-4',number:4,text:'444',target:{kind:'block',blockId:'block-18'}}
  ],nextAnnotationNumber:5});
}

test('default selection draws a feedback region without requiring a mode or add button',()=>{
  assert.equal(selectionIntent(),'draw-region');
  assert.equal(selectionIntent({tool:'select'}),'draw-region');
  assert.equal(selectionIntent({tool:'layout'}),'draw-region','a stale mode value must not create a separate draw-block path');
});
test('existing annotation and block hits reuse existing targets instead of duplicating notes',()=>{
  assert.equal(selectionIntent({noteId:'n1',blockId:'b1'}),'edit-note');
  assert.equal(selectionIntent({blockId:'b1'}),'move-block');
  assert.equal(selectionIntent({tool:'point',blockId:'b1'}),'point');
  assert.equal(selectionIntent({noteId:'n1',blockId:'b1',forceNew:true}),'draw-region');
  assert.equal(selectionIntent({tool:'pan',noteId:'n1'}),'pan');
});
test('selecting regions and points uses their move intents while other note hits still edit text',()=>{
  assert.equal(selectionIntent({noteId:'region-1',noteKind:'region'}),'move-region');
  assert.equal(selectionIntent({tool:'select',noteId:'region-1',noteKind:'region',blockId:'underneath'}),'move-region');
  assert.equal(selectionIntent({tool:'point',noteId:'region-1',noteKind:'region'}),'edit-note');
  assert.equal(selectionIntent({noteId:'point-1',noteKind:'point'}),'move-point');
  assert.equal(selectionIntent({noteId:'block-note',noteKind:'block',blockId:'b1'}),'edit-note');
  assert.equal(selectionIntent({noteId:'global-1',noteKind:'global'}),'edit-note');
  assert.equal(selectionIntent({noteId:'region-1',noteKind:'region',blockId:'b1',forceNew:true}),'draw-region');
  assert.equal(selectionIntent({tool:'point',noteId:'region-1',noteKind:'region',forceNew:true}),'point');
  assert.equal(selectionIntent({tool:'pan',noteId:'region-1',noteKind:'region'}),'pan');
});
test('both select and point tools move free/local point markers while pan and force-new keep priority',()=>{
  for(const tool of ['select','point']){
    assert.equal(selectionIntent({tool,noteId:'free',noteKind:'point'}),'move-point');
    assert.equal(selectionIntent({tool,noteId:'local',noteKind:'block',noteLocalKind:'point',blockId:'b'}),'move-point');
    assert.equal(selectionIntent({tool,noteId:'whole',noteKind:'block',blockId:'b'}),'edit-note');
    assert.equal(selectionIntent({tool,noteId:'local-region',noteKind:'block',noteLocalKind:'region',blockId:'b'}),'edit-note');
    assert.equal(selectionIntent({tool,noteId:'free',noteKind:'point',forceNew:true}),tool==='point'?'point':'draw-region');
    assert.equal(selectionIntent({tool,noteId:'local',noteKind:'block',noteLocalKind:'point',blockId:'b',forceNew:true}),tool==='point'?'point':'draw-region');
  }
  assert.equal(selectionIntent({tool:'pan',noteId:'local',noteKind:'block',noteLocalKind:'point'}),'pan');
  assert.equal(selectionIntent({tool:'pan',noteId:'free',noteKind:'point',forceNew:true}),'pan');
});
test('screen-space threshold avoids accidental regions while reverse dragging uses exact source pixels',()=>{
  assert.equal(selectionRectangle({x:20,y:20},{x:21,y:21},1),null);
  assert.equal(selectionRectangle({x:0,y:0},{x:4,y:4},.1),null);
  assert.deepEqual(selectionRectangle({x:200.6,y:130.3},{x:40.2,y:50.4},1),{x:40,y:50,width:161,height:80});
  assert.equal(selectionRectangle({x:0,y:0},{x:80,y:1},1),null);
});
test('region promotion creates a detached cut candidate without changing the original feedback',()=>{
  const d=core.addAnnotation(fresh(),{text:'Keep the text readable',target:{kind:'region',space:'layout',rect:{x:40,y:50,width:160,height:100}}});
  assert.equal(d.blocks.length,0);
  const note=d.annotations[0],result=promoteRegion(core,d,note.id);
  assert.equal(d.blocks.length,0);
  assert.equal(result.draft.blocks.length,1);
  assert.equal(result.draft.annotations[0].id,note.id);
  assert.equal(result.draft.annotations[0].number,note.number);
  assert.equal(result.draft.annotations[0].text,note.text);
  assert.deepEqual(result.draft.annotations[0].target,{kind:'block',blockId:result.blockId});
  const moved=core.moveBlock(result.draft,result.blockId,{x:220,y:70});
  assert.deepEqual(core.resolveAnnotation(moved,note.id).layout.rect,{x:220,y:70,width:160,height:100});
});
test('region promotion rejects ambiguous overlap without modifying the original annotation',()=>{
  let d=core.addBlock(fresh(),{x:40,y:50,width:160,height:100});
  d=core.addAnnotation(d,{text:'Do not lose this',target:{kind:'region',space:'layout',rect:{x:80,y:70,width:80,height:50}}});
  const before=core.serializeDraft(d);
  assert.throws(()=>promoteRegion(core,d,d.annotations[0].id),/overlaps/);
  assert.equal(core.serializeDraft(d),before);
  assert.throws(()=>promoteRegion(core,d,'missing'),/Select a rectangle/);
});
test('selecting a block can expose an empty editor without creating an empty annotation',()=>{
  const d=core.addBlock(fresh(),{x:40,y:50,width:160,height:100}),id=d.blocks[0].id;
  assert.equal(blockComment(d,id,null),null);
  const empty=writeBlockComment(core,d,id,'',null);
  assert.equal(empty.draft,d);assert.equal(empty.noteId,null);assert.equal(d.annotations.length,0);
});
test('first block text creates one bound note and subsequent typing updates that same note',()=>{
  const d=core.addBlock(fresh(),{x:40,y:50,width:160,height:100}),id=d.blocks[0].id;
  const first=writeBlockComment(core,d,id,'A',null),second=writeBlockComment(core,first.draft,id,'A complete thought',null);
  assert.equal(first.noteId,second.noteId);
  assert.equal(second.draft.annotations.length,1);
  assert.equal(second.draft.annotations[0].text,'A complete thought');
  assert.equal(second.draft.annotations[0].target.blockId,id);
});
test('a selected component-local point note keeps its anchor when edited',()=>{
  let d=core.addBlock(fresh(),{x:40,y:50,width:160,height:100});const id=d.blocks[0].id;
  d=core.addAnnotation(d,{text:'Point detail',target:{kind:'block',blockId:id,local:{kind:'point',point:{x:10,y:20}}}});
  const note=d.annotations[0],result=writeBlockComment(core,d,id,'Updated point detail',note.id);
  assert.equal(result.noteId,note.id);assert.deepEqual(result.draft.annotations[0].target,note.target);
  assert.equal(blockComment(d,id,'unrelated'),null);
});

test('saved 640x400 geometry allows destination-only overlap without changing either existing block',()=>{
  const d=savedGeometry(),before=core.serializeDraft(d),frame=d.annotations[0].target.rect;
  const old18=d.blocks[0],old23=d.blocks[1],oldBoundNote=d.annotations[1];
  assert.equal(core.rectanglesOverlap(frame,old18.destination),true);
  assert.equal(d.blocks.some(block=>core.rectanglesOverlap(frame,block.source)),false);
  const result=promoteRegion(core,d,'note-1');
  assert.equal(result.draft.blocks.length,3);
  assert.deepEqual(result.draft.blocks.find(block=>block.id===result.blockId).source,{x:45,y:51,width:153,height:96});
  const moved=core.moveBlock(result.draft,result.blockId,{x:280,y:150},{bounds:'clamp'});
  assert.equal(moved.blocks.find(block=>block.id==='block-18'),old18);
  assert.equal(moved.blocks.find(block=>block.id==='block-23'),old23);
  assert.equal(moved.annotations.find(note=>note.id==='note-4'),oldBoundNote);
  assert.equal(moved.annotations.find(note=>note.id==='note-1').text,'111');
  assert.equal(moved.annotations.find(note=>note.id==='note-1').number,1);
  assert.deepEqual(moved.blocks.find(block=>block.id===result.blockId).destination,{x:280,y:150,width:153,height:96});
  assert.equal(core.serializeDraft(d),before);
});

test('saved geometry hit at 80,70 selects visible block-18 despite an overlapping free-region annotation',()=>{
  const d=savedGeometry(),point={x:80,y:70};
  assert.equal(core.containsPoint(d.annotations[0].target.rect,point),true);
  assert.equal(core.hitTest(d,point).id,'block-18');
  assert.deepEqual(core.hitTest(d,point).source,{x:399,y:26,width:147,height:93});
});

test('an exact destination frame rebinds to the existing block without recutting or changing old comments',()=>{
  const original=savedGeometry(),old18=original.blocks[0],old23=original.blocks[1],oldBound=original.annotations[1];
  const d=core.addAnnotation(original,{text:'Another written instruction',target:{kind:'region',space:'layout',rect:old18.destination}});
  const added=d.annotations.at(-1),result=promoteRegion(core,d,added.id);
  assert.equal(result.blockId,'block-18');
  assert.equal(result.draft.blocks,d.blocks);
  assert.equal(result.draft.blocks.length,2);
  const rebound=result.draft.annotations.find(note=>note.id===added.id);
  assert.equal(rebound.text,added.text);assert.equal(rebound.number,added.number);
  assert.deepEqual(rebound.target,{kind:'block',blockId:'block-18'});
  const moved=core.moveBlock(result.draft,result.blockId,{x:300,y:200});
  assert.equal(moved.blocks.find(block=>block.id==='block-18').source,old18.source);
  assert.equal(moved.blocks.find(block=>block.id==='block-23'),old23);
  assert.equal(moved.annotations.find(note=>note.id==='note-4'),oldBound);
  assert.equal(moved.annotations.find(note=>note.id==='note-1'),original.annotations[0]);
  assert.deepEqual(core.resolveAnnotation(moved,'note-4').layout.rect,{x:300,y:200,width:147,height:93});
});

test('exact destination reuse chooses the topmost matching block consistently with hit testing',()=>{
  let d=core.addBlock(fresh(),{x:0,y:0,width:20,height:20},{id:'low'});
  d=core.addBlock(d,{x:40,y:0,width:20,height:20},{id:'high'});
  d=core.moveBlock(core.moveBlock(d,'low',{x:100,y:100}),'high',{x:100,y:100});
  d=core.addAnnotation(d,{text:'Select visible top block',target:{kind:'region',space:'layout',rect:{x:100,y:100,width:20,height:20}}});
  const id=d.annotations[0].id,result=promoteRegion(core,d,id);
  assert.equal(result.blockId,'high');assert.equal(result.blockId,core.hitTest(d,{x:105,y:105}).id);
  assert.equal(result.draft.blocks.length,2);
  const reordered=core.reorderBlock(d,'low','front');
  assert.equal(promoteRegion(core,reordered,id).blockId,'low');
});

test('exact destination reuse is allowed even when that destination covers another block source',()=>{
  let d=core.addBlock(fresh(),{x:0,y:0,width:20,height:20},{id:'visible'});
  d=core.moveBlock(d,'visible',{x:100,y:100});
  d=core.addBlock(d,{x:100,y:100,width:20,height:20},{id:'other-source'});
  d=core.moveBlock(d,'other-source',{x:200,y:200});
  d=core.addAnnotation(d,{text:'Reuse, do not recut',target:{kind:'region',space:'layout',rect:{x:100,y:100,width:20,height:20}}});
  const result=promoteRegion(core,d,d.annotations[0].id);
  assert.equal(result.blockId,'visible');assert.equal(result.draft.blocks,d.blocks);
});

test('partial source-only overlap stays rejected while the saved draft and all comments remain intact',()=>{
  const d=core.addAnnotation(savedGeometry(),{text:'Retain this pending range',target:{kind:'region',space:'layout',rect:{x:410,y:30,width:40,height:40}}});
  const note=d.annotations.at(-1),before=core.serializeDraft(d);
  assert.equal(core.rectanglesOverlap(note.target.rect,d.blocks[0].source),true);
  assert.equal(d.blocks.some(block=>core.rectanglesOverlap(note.target.rect,block.destination)),false);
  assert.throws(()=>promoteRegion(core,d,note.id),/already-owned source pixels/);
  assert.equal(core.serializeDraft(d),before);
});

test('free point moves retain layout anchoring and metadata even over a block, with canvas pixel clamping',()=>{
  const original=savedGeometry();
  const d=core.addAnnotation(original,{id:'free-point',text:'Keep this exact text',target:{kind:'point',space:'layout',point:{x:300,y:50}}});
  const note=d.annotations.at(-1),before=core.serializeDraft(d);
  const result=movePointAnnotation(core,d,note.id,{x:80,y:70}),moved=result.draft.annotations.at(-1);
  assert.equal(result.noteId,note.id);assert.equal(Object.hasOwn(result,'blockId'),false);
  assert.equal(moved.id,note.id);assert.equal(moved.number,note.number);assert.equal(moved.text,note.text);
  assert.deepEqual(moved.target,{kind:'point',space:'layout',point:{x:80,y:70}});
  assert.equal(core.hitTest(d,{x:80,y:70}).id,'block-18','crossing a visible block must not rebind the point');
  assert.equal(result.draft.blocks,d.blocks);assert.equal(result.draft.asset,d.asset);
  assert.equal(result.draft.annotations[0],d.annotations[0]);assert.equal(result.draft.annotations[1],d.annotations[1]);
  assert.deepEqual(movePointAnnotation(core,d,note.id,{x:-100,y:1000}).draft.annotations.at(-1).target.point,{x:0,y:399});
  assert.deepEqual(movePointAnnotation(core,d,note.id,{x:640,y:-100}).draft.annotations.at(-1).target.point,{x:639,y:0});
  assert.equal(movePointAnnotation(core,result.draft,note.id,{x:80,y:70}).draft,result.draft);
  assert.equal(core.serializeDraft(d),before);
});

test('block-local point moves map absolute layout coordinates to the same block and never move image pixels',()=>{
  const d=core.addAnnotation(savedGeometry(),{id:'local-point',text:'  Local detail  ',target:{kind:'block',blockId:'block-18',local:{kind:'point',point:{x:20,y:10}}}});
  const note=d.annotations.at(-1),oldBlocks=d.blocks,oldSource=oldBlocks[0].source;
  const result=movePointAnnotation(core,d,note.id,{x:80,y:70}),target=result.draft.annotations.at(-1).target;
  assert.equal(result.blockId,'block-18');assert.equal(result.noteId,note.id);
  assert.deepEqual(target,{kind:'block',blockId:'block-18',local:{kind:'point',point:{x:66,y:63}}});
  assert.deepEqual(core.resolveAnnotation(result.draft,note.id).layout.point,{x:80,y:70});
  assert.deepEqual(core.resolveAnnotation(result.draft,note.id).source.point,{x:465,y:89});
  assert.equal(result.draft.blocks,oldBlocks);assert.equal(result.draft.blocks[0].source,oldSource);
  assert.equal(result.draft.annotations.at(-1).text,note.text);assert.equal(result.draft.annotations.at(-1).number,note.number);
  const clamped=movePointAnnotation(core,result.draft,note.id,{x:-999,y:999});
  assert.deepEqual(clamped.draft.annotations.at(-1).target.local.point,{x:0,y:92});
  assert.equal(clamped.draft.annotations.at(-1).target.blockId,'block-18');
  const overAnotherBlock=movePointAnnotation(core,d,note.id,{x:170,y:190});
  assert.deepEqual(overAnotherBlock.draft.annotations.at(-1).target.local.point,{x:146,y:92});
  assert.equal(overAnotherBlock.blockId,'block-18');
  const laterBlockMove=core.moveBlock(result.draft,'block-18',{x:200,y:200});
  assert.deepEqual(core.resolveAnnotation(laterBlockMove,note.id).layout.point,{x:266,y:263});
});

test('point clamping handles one-pixel assets and blocks without creating invalid negative coordinates',()=>{
  const small=core.createDraft({sessionId:'tiny',asset:{assetId:'tiny',width:1,height:1}});
  const free=core.addAnnotation(small,{text:'pixel',target:{kind:'point',space:'layout',point:{x:0,y:0}}});
  assert.deepEqual(movePointAnnotation(core,free,free.annotations[0].id,{x:99,y:-99}).draft.annotations[0].target.point,{x:0,y:0});
  const cut=core.addBlock(small,{x:0,y:0,width:1,height:1});
  const local=core.addAnnotation(cut,{text:'local pixel',target:{kind:'block',blockId:cut.blocks[0].id,local:{kind:'point',point:{x:0,y:0}}}});
  const result=movePointAnnotation(core,local,local.annotations[0].id,{x:-99,y:99});
  assert.deepEqual(result.draft.annotations[0].target.local.point,{x:0,y:0});
  assert.equal(result.draft.blocks,local.blocks);
});

test('point moves reject nonfinite or malformed coordinates and nonpoint annotations without mutation',()=>{
  let d=core.addAnnotation(savedGeometry(),{id:'valid-point',text:'keep',target:{kind:'point',space:'layout',point:{x:20,y:30}}});
  d=core.addAnnotation(d,{id:'global-note',text:'global',target:{kind:'global'}});
  d=core.addAnnotation(d,{id:'local-region',text:'region',target:{kind:'block',blockId:'block-18',local:{kind:'region',rect:{x:1,y:1,width:10,height:10}}}});
  const before=core.serializeDraft(d);
  for(const position of [{x:NaN,y:0},{x:Infinity,y:0},{x:0,y:-Infinity},{x:'1',y:0},{x:1},null]){
    assert.throws(()=>movePointAnnotation(core,d,'valid-point',position),error=>error instanceof core.CoreError);
  }
  for(const id of ['note-1','note-4','global-note','local-region'])assert.throws(()=>movePointAnnotation(core,d,id,{x:50,y:50}),/Only point annotations/);
  assert.throws(()=>movePointAnnotation(core,d,'missing',{x:50,y:50}),error=>error.code==='MISSING_ANNOTATION');
  assert.equal(core.serializeDraft(d),before);
});
