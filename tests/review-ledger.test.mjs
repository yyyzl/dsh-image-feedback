import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import core from '../editor-core.js';
const fresh=()=>core.createDraft({sessionId:'review',asset:{assetId:'a',width:640,height:400}});
const moved=(draft,x=20)=>{const next=core.addBlock(draft,{x,y:20,width:40,height:40}),id=next.blocks.at(-1).id;return {draft:core.moveBlock(next,id,{x:x+100,y:90}),id};};
const note=(draft,text='Comment',target={kind:'global'})=>core.addAnnotation(draft,{text,target});

test('one ledger interleaves generated comments and move-only blocks with contiguous labels',()=>{
 let d=note(fresh(),'First',{kind:'point',space:'layout',point:{x:5,y:5}});
 const move=moved(d);d=move.draft;d=note(d,'Third');
 const items=core.getReviewItems(d);
 assert.deepEqual(items.map(i=>i.number),[1,2,3]);
 assert.deepEqual(items.map(i=>i.kind),['comment','move','global']);
 assert.equal(items[1].blockId,move.id);assert.equal(items[1].annotationId,null);
 assert.deepEqual(items[1].layout.rect,d.blocks[0].destination);
 assert.ok(Object.isFrozen(items));assert.ok(Object.isFrozen(items[1]));
});
test('adding text to a moved block keeps its key, number and crop; local point notes remain separately editable',()=>{
 const move=moved(fresh());let d=note(move.draft,'Later');
 const before=core.getReviewItems(d)[0];
 d=note(d,'Move this card',{kind:'block',blockId:move.id});
 d=note(d,'This detail',{kind:'block',blockId:move.id,local:{kind:'point',point:{x:4,y:6}}});
 const items=core.getReviewItems(d),item=items[0];
 assert.equal(item.key,before.key);assert.equal(item.number,before.number);assert.equal(item.text,'Move this card');
 assert.equal(items.filter(i=>i.move).length,1);
 assert.equal(items.at(-1).annotationId,d.annotations.at(-1).id);
 assert.deepEqual(items.at(-1).layout.point,{x:124,y:96});
});
test('deletion closes display gaps without rewriting legacy identities; undo restores exact numbering',()=>{
 let d=note(fresh(),'One');d=note(d,'Two');const first=d.annotations[0].id,second=d.annotations[1];
 const history=new core.History(d);history.commit(core.removeAnnotation(d,first));
 const current=history.current,items=core.getReviewItems(current);
 assert.equal(current.annotations[0].number,2);assert.equal(items[0].number,1);assert.equal(items[0].annotationId,second.id);
 assert.deepEqual(core.getReviewItems(history.undo()).map(i=>i.number),[1,2]);
 assert.deepEqual(core.getReviewItems(core.deserializeDraft(core.serializeDraft(current))),items);
});
test('block movement and z-index changes do not reorder display identity',()=>{
 let one=moved(fresh()),two=moved(one.draft,80);let d=two.draft;
 const keys=core.getReviewItems(d).map(i=>i.key);
 d=core.moveBlock(d,one.id,{x:400,y:280});
 assert.deepEqual(core.getReviewItems(d).map(i=>i.key),keys);
 // Reading the review projection never changes persisted identity or history.
 const before=core.serializeDraft(d);core.getReviewItems(d);assert.equal(core.serializeDraft(d),before);
});
test('feedback text and exported-reference source both use the exact same presentation ledger',async()=>{
 let d=note(fresh(),'Delete me');d=note(d,'Keep me',{kind:'point',space:'layout',point:{x:10,y:10}});
 d=core.removeAnnotation(d,d.annotations[0].id);const move=moved(d);d=move.draft;
 const items=core.getReviewItems(d),feedback=core.buildFeedback(d);
 assert.match(feedback.text,/#1 \[fixed layout point/);
 assert.match(feedback.text,/#2 Block/);
 assert.doesNotMatch(feedback.text,/Reference block labels:|B1 =/);
 for(const item of items)assert.ok(feedback.text.includes('#'+item.number+' = '+JSON.stringify(item.key)));
 assert.deepEqual(core.deserializeDraft(feedback.json),d);
 const adapter=await readFile(new URL('../src/editor.js',import.meta.url),'utf8');
 assert.match(adapter,/for\(const item of core.getReviewItems\(draft\)\)/);
 assert.match(adapter,/fillText\(String\(item.number\)/);
 const view=await readFile(new URL('../src/editor-view.js',import.meta.url),'utf8');
 assert.match(view,/displayItems.map\(item/);assert.match(view,/items.map\(item=>h\('div'/);
 assert.match(view,/pointerEvents:item.annotation\?\.target.kind==='region'\?undefined:'none'/);
 assert.match(view,/fingerprint='unified-v1/);
 assert.match(adapter,/grant.reviewLabels!=='unified-v1'/);
 assert.doesNotMatch(view,/activeNote\?\.number\|\|'B'|inspector,\s*\.\.\.draft.annotations/);
});
