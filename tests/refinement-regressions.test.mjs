import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import core from '../editor-core.js';
import {anchoredZoomPlan} from '../src/editor-intent.js';
test('custom-ID moved blocks retain order when their first whole-block comment is added',()=>{
 let d=core.createDraft({sessionId:'s',asset:{assetId:'a',width:640,height:400}});
 for(const [id,x] of [['card-a',20],['card-b',80]]){d=core.addBlock(d,{x,y:20,width:40,height:40},{id});d=core.moveBlock(d,id,{x:x+100,y:100});}
 const before=core.getReviewItems(d).map(i=>[i.key,i.number]);
 d=core.addAnnotation(d,{text:'First character',target:{kind:'block',blockId:'card-b'}});
 assert.deepEqual(core.getReviewItems(d).map(i=>[i.key,i.number]),before);
});
test('one pinch retains its exact anchor while centered, then anchors correctly after overflowing',()=>{
 const base={width:200,height:100,viewportWidth:400,viewportHeight:300,scale:1,scrollLeft:0,scrollTop:0,x:250,y:150,anchor:{x:150,y:50}};
 const centered=anchoredZoomPlan({...base,nextScale:1.2});assert.equal(centered.scrollLeft,0);
 const large=anchoredZoomPlan({...base,scale:1.2,nextScale:3,scrollLeft:centered.scrollLeft,scrollTop:centered.scrollTop});
 assert.equal(large.point.x,150);assert.equal(large.scrollLeft,220);
 const bound=anchoredZoomPlan({...base,nextScale:100});assert.equal(bound.scale,8);
 const reverse=anchoredZoomPlan({...base,scale:8,nextScale:3,scrollLeft:bound.scrollLeft,scrollTop:bound.scrollTop});assert.equal(reverse.scrollLeft,large.scrollLeft);
});
test('first-character editor relocation restores focus; wheel bursts use a stable anchor with timer cleanup',async()=>{
 const view=await readFile(new URL('../src/editor-view.js',import.meta.url),'utf8');
 assert.match(view,/if\(result.noteId!==selectedNote\)\{setSelectedNote\(result.noteId\);focusEditor\(\);\}/);
 assert.match(view,/client,gesture.point\)/);
 assert.match(view,/anchor:fixedPoint/);
 assert.match(view,/stage.removeEventListener\('gestureend',end\);clearWheelGesture\(\)/);
 assert.match(view,/clearTimeout\(wheelTimer.current\)/);
});
