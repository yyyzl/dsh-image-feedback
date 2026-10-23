import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import core from '../editor-core.js';
import {smartHoverCandidate,prepareSmartHoverIndex,selectionGestureCurrent,smartSelectionOutline,selectionGestureResult,selectionIntent} from '../src/editor-intent.js';
const fresh=()=>core.createDraft({sessionId:'smart-test',asset:{assetId:'synthetic',width:640,height:400}});
const candidate=(id,x,y,width,height)=>({id,rect:{x,y,width,height},score:1,kind:'control'});
const picker={pick:(list,p)=>list.find(item=>p.x>=item.rect.x&&p.y>=item.rect.y&&p.x<item.rect.x+item.rect.width&&p.y<item.rect.y+item.rect.height)||null};
const index=(draft,candidates)=>({assetId:draft.asset.assetId,width:640,height:400,candidates});
test('smart hover reads a source-bound index without adding a note, saving, or changing source pixels',()=>{
 const draft=fresh(),item=candidate('button',20,30,100,40),before=core.serializeDraft(draft);
 assert.equal(smartHoverCandidate(core,picker,draft,index(draft,[item]),{x:50,y:50}),item);
 assert.equal(core.serializeDraft(draft),before);
 assert.equal(draft.annotations.length,0);assert.equal(draft.blocks.length,0);
});
test('image changes, dimension mismatches, empty index and out-of-range positions cannot reuse stale previews',()=>{
 const draft=fresh(),i=index(draft,[candidate('a',20,20,40,40)]);
 for(const wrong of [null,{...i,assetId:'old'},{...i,width:100},{...i,height:100}])assert.equal(smartHoverCandidate(core,picker,draft,wrong,{x:25,y:25}),null);
 for(const p of [{x:-1,y:20},{x:640,y:20},{x:20,y:400},{x:NaN,y:20}])assert.equal(smartHoverCandidate(core,picker,draft,i,p),null);
});
test('source holes and moved or occluded layout pixels cannot produce an invalid second cut',()=>{
 let draft=core.addBlock(fresh(),{x:20,y:20,width:80,height:60});draft=core.moveBlock(draft,draft.blocks[0].id,{x:240,y:60});
 const source=candidate('hole',10,10,100,100),target=candidate('target',230,50,100,100),safe=candidate('safe',400,200,60,40);
 const i=index(draft,[source,target,safe]);
 assert.equal(smartHoverCandidate(core,picker,draft,i,{x:15,y:15}),null);
 assert.equal(smartHoverCandidate(core,picker,draft,i,{x:250,y:70}),null);
 assert.equal(smartHoverCandidate(core,picker,draft,i,{x:235,y:55}),null);
 assert.equal(smartHoverCandidate(core,picker,draft,i,{x:410,y:210}),safe);
});
test('prepared ownership filtering is reusable across hover points and text-only draft changes',()=>{
 const draft=fresh(),i=index(draft,[candidate('a',20,20,40,40)]),prepared=prepareSmartHoverIndex(core,draft,i);
 assert.equal(prepareSmartHoverIndex(core,draft,prepared),prepared);
 const typed=core.addAnnotation(draft,{text:'Example',target:{kind:'global'}});
 assert.equal(typed.blocks,draft.blocks);assert.equal(prepareSmartHoverIndex(core,typed,prepared),prepared);
 let moved=core.addBlock(typed,{x:20,y:20,width:40,height:40});moved=core.moveBlock(moved,moved.blocks[0].id,{x:100,y:100});
 assert.notEqual(prepareSmartHoverIndex(core,moved,prepared),prepared);
 assert.equal(prepareSmartHoverIndex(core,moved,prepared).candidates.length,0);
});
test('gesture ownership rejects replaced histories and controllers even with identical assets and numeric versions',()=>{
 const draft=fresh(),history=new core.History(draft),otherHistory=new core.History(draft);
 let state={draft,history};const controller={getSnapshot:()=>state};
 const gesture={owner:controller,sessionId:'smart-test',history,version:history.version,assetId:draft.asset.assetId,kind:'draw-region'};
 assert.equal(selectionGestureCurrent(gesture,controller,'smart-test'),true);
 assert.equal(selectionGestureCurrent(gesture,controller,'other-session'),false);
 const otherController={getSnapshot:()=>state};assert.equal(selectionGestureCurrent(gesture,otherController,'smart-test'),false);
 state={draft,history:otherHistory};assert.equal(history.version,otherHistory.version);assert.equal(selectionGestureCurrent(gesture,controller,'smart-test'),false);
 state={draft:null,history:null};assert.equal(selectionGestureCurrent(gesture,controller,'smart-test'),false);
});
test('click adopts exactly the pressed candidate with a fresh rectangle, while a drag always uses user coordinates',()=>{
 const item=candidate('button',20,30,100,40),start={x:50,y:50};
 const clicked=selectionGestureResult(start,{x:51,y:50},1,item,false);
 assert.deepEqual(clicked,item.rect);assert.notEqual(clicked,item.rect);
 assert.deepEqual(selectionGestureResult(start,{x:150,y:110},1,item,false),{x:50,y:50,width:100,height:60});
 assert.deepEqual(selectionGestureResult({x:150,y:110},start,1,item,true),{x:50,y:50,width:100,height:60});
});
test('shape outlines map normalized geometry without null dereferences or arbitrary SVG attributes',()=>{
 const rect={x:10,y:20,width:100,height:60};
 assert.equal(smartSelectionOutline(null),null);assert.equal(smartSelectionOutline(undefined),null);assert.equal(smartSelectionOutline({rect:{...rect,width:NaN}}),null);
 assert.deepEqual(smartSelectionOutline({rect,shape:'ellipse'}),{tag:'ellipse',attrs:{cx:60,cy:50,rx:50,ry:30}});
 assert.deepEqual(smartSelectionOutline({rect,shape:'capsule'}),{tag:'rect',attrs:{...rect,rx:30}});
 assert.deepEqual(smartSelectionOutline({rect,shape:'polygon',outline:[[.2,0],[1,0],[.8,1],[0,1]]}),{tag:'polygon',attrs:{points:'30,20 110,20 90,80 10,80'}});
 for(const outline of [null,[],[[2,0],[0,0],[1,1]],[[NaN,0],[0,0],[1,1]]])assert.deepEqual(smartSelectionOutline({rect,shape:'polygon',outline}),{tag:'rect',attrs:rect});
});
test('nonrectangular recommendations confirm as bounding rectangles without adding shape or mask fields to drafts',()=>{
 const start={x:50,y:50},rect={x:20,y:20,width:80,height:70};
 for(const shape of ['ellipse','capsule','polygon']){
   const item={id:shape,shape,rect,outline:[[.5,0],[1,1],[0,1]]};
   const adopted=selectionGestureResult(start,start,1,item,false);
   assert.deepEqual(adopted,rect);assert.deepEqual(Object.keys(adopted).sort(),['height','width','x','y']);
   const next=core.addAnnotation(fresh(),{text:'Example',target:{kind:'region',space:'layout',rect:adopted}});
   assert.equal(next.annotations[0].target.kind,'region');assert.deepEqual(next.annotations[0].target.rect,rect);
 }
});
test('manual drag cannot snap back to a candidate when returning close to its start or drawing a degenerate line',()=>{
 const item=candidate('button',20,30,100,40),start={x:50,y:50};
 assert.equal(selectionGestureResult(start,{x:51,y:50},1,item,true),null);
 assert.equal(selectionGestureResult(start,{x:80,y:50},1,item,true),null);
 assert.equal(selectionGestureResult(start,start,1,null,false),null);
 assert.equal(selectionGestureResult(start,start,1,{rect:{x:0,y:0,width:Infinity,height:10}},false),null);
});
test('screen distance controls click-versus-drag without zoom-dependent snapping',()=>{
 const item=candidate('button',20,30,100,40),start={x:50,y:50};
 assert.deepEqual(selectionGestureResult(start,{x:52,y:51},.5,item,false),item.rect);
 assert.equal(selectionGestureResult(start,{x:52,y:51},4,item,false),null);
});
test('existing region and point manipulation retains priority over smart click adoption',()=>{
 assert.equal(selectionIntent({tool:'select',blockId:'block-a'}),'move-block');
 assert.equal(selectionIntent({tool:'select',noteId:'a',noteKind:'region'}),'move-region');
 assert.equal(selectionIntent({tool:'select',noteId:'a',noteKind:'point'}),'move-point');
 assert.equal(selectionIntent({tool:'select',blockId:'block-a',forceNew:true}),'draw-region');
});
test('initial empty draft and empty smart state never dereference matching undefined identities',async()=>{
 const view=await readFile(new URL('../src/editor-view.js',import.meta.url),'utf8');
 const indexExpression=view.match(/const sourceSmartIndex=([^;]+);/)[1];
 const previewExpression=view.match(/const smartPreview=([^;]+);/)[1];
 const readIndex=Function('draft','smartScan','return '+indexExpression);
 const readPreview=Function('draft','smartHover','smartEnabled','tool','isLocked','pointer','return '+previewExpression);
 const draft={asset:{assetId:'image-a'}},index={width:640,height:400},candidate={id:'target'};
 for(const empty of [null,undefined]){
   assert.equal(readIndex(empty,null),null);assert.equal(readIndex(empty,undefined),null);
   assert.equal(readPreview(empty,null,true,'select',false,{current:null}),null);
   assert.equal(readPreview(empty,undefined,true,'select',false,{current:null}),null);
 }
 assert.equal(readIndex(draft,null),null);assert.equal(readPreview(draft,null,true,'select',false,{current:null}),null);
 assert.equal(readIndex(draft,{assetId:'image-a',index}),index);
 assert.equal(readPreview(draft,{assetId:'image-a',candidate},true,'select',false,{current:null}),candidate);
 assert.equal(readPreview(draft,{assetId:'image-old',candidate},true,'select',false,{current:null}),null);
});
test('view captures a suggestion on down only, draws a non-interactive overlay, and exposes a manual-only escape',async()=>{
 const view=await readFile(new URL('../src/editor-view.js',import.meta.url),'utf8');
 const down=view.slice(view.indexOf('function down('),view.indexOf('function destination('));
 const move=view.slice(view.indexOf('function move('),view.indexOf('function cancelPointer('));
 const up=view.slice(view.indexOf('function up('),view.indexOf('function key('));
 assert.match(down,/start:p,candidate,manual:false/);
 assert.match(down,/!event.shiftKey&&event.pointerType!=='touch'/);
 assert.match(move,/a.manual=true/);
 assert.match(up,/selectionGestureResult\(a.start,p,scale,event.shiftKey\?null:a.candidate,a.manual\)/);
 assert.doesNotMatch(up,/smartHoverCandidate/);
 assert.match(view,/'data-smart-preview':true[\s\S]*pointerEvents:'none','aria-hidden':true/);
 assert.match(view,/setSmartEnabled\(value=>!value\)/);
 assert.match(view,/return\(\)=>\{current=false;stop.abort\(\);\}/);
 assert.match(down,/pointerId:event.pointerId/);
 assert.match(move,/if\(a.pointerId!==event.pointerId\)return/);
 assert.match(up,/!a\|\|a.pointerId!==event.pointerId/);
 assert.match(up,/!now.draft\|\|!now.history/);
});
