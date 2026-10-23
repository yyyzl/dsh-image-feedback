import test from 'node:test';
import assert from 'node:assert/strict';
import {createSmartSelectionClient} from '../src/smart-selection-client.js';
const asset=id=>({assetId:id,url:'https://fixture.invalid/'+id,width:64,height:40});
const pixels=()=>({pixels:{width:64,height:40,data:new Uint8ClampedArray(64*40*4)},ratio:1});
const answer=(worker,post=worker.posts.at(-1))=>worker.onmessage({data:{id:post.id,candidates:[{id:'control',rect:{x:10,y:10,width:20,height:16},score:.9,kind:'control'}]}});
function harness(readPixels=async()=>pixels()){
 const workers=[];
 const client=createSmartSelectionClient({readPixels,createWorker:()=>{
   const waiters=[];
   const worker={posts:[],terminated:false,postMessage(message){this.posts.push(message);for(const done of waiters.splice(0))done(message);},terminate(){this.terminated=true;},posted(){return this.posts.length?Promise.resolve(this.posts.at(-1)):new Promise(resolve=>waiters.push(resolve));}};
   workers.push(worker);return worker;
 }});
 return {client,workers};
}
const turn=()=>new Promise(resolve=>setImmediate(resolve));
test('same-image consumers share a single worker job and aborting one does not reject another',async t=>{
 const h=harness();t.after(()=>h.client.dispose());const abort=new AbortController();
 const one=h.client.analyze(asset('a'),{signal:abort.signal}),two=h.client.analyze(asset('a'));
 const cancelled=assert.rejects(one,/cancelled/);await turn();assert.equal(h.workers.length,1);assert.equal(h.workers[0].posts.length,1);
 abort.abort();await cancelled;assert.equal(h.workers[0].terminated,false);answer(h.workers[0]);
 const result=await two;assert.equal(result.assetId,'a');assert.equal(result.candidates.length,1);
 assert.equal(await h.client.analyze(asset('a')),result,'completed cache reuses the exact immutable index');
});
test('cancelled worker callbacks cannot revoke or kill a newer worker and cannot publish old candidates',async t=>{
 const h=harness();t.after(()=>h.client.dispose());const abort=new AbortController();
 const one=h.client.analyze(asset('a'),{signal:abort.signal});const cancelled=assert.rejects(one,/cancelled/);
 await turn();const old=h.workers[0];abort.abort();await cancelled;assert.equal(old.terminated,true);
 const two=h.client.analyze(asset('b'));await turn();const current=h.workers[1];
 old.onmessage({data:{ready:true}});old.onerror(new Error('late error'));old.onmessageerror();answer(old);
 assert.equal(current.terminated,false);answer(current);assert.equal((await two).assetId,'b');
});
test('only one decode is admitted and only the latest waiting image is retained',async t=>{
 const decodes=[],gates=[];const h=harness(a=>{decodes.push(a.assetId);return new Promise(resolve=>gates.push(resolve));});t.after(()=>h.client.dispose());
 const first=h.client.analyze(asset('a')),second=h.client.analyze(asset('b'));const superseded=assert.rejects(second,/superseded/);
 const third=h.client.analyze(asset('c'));await superseded;assert.deepEqual(decodes,['a']);
 gates.shift()(pixels());await turn();answer(h.workers[0]);await first;assert.deepEqual(decodes,['a','c']);
 gates.shift()(pixels());await turn();assert.equal(h.workers.length,1,'successful tasks reuse the same worker');answer(h.workers[0]);assert.equal((await third).assetId,'c');
});
test('a cancelled decode completing late never posts into the next image job',async t=>{
 let finishOld;const h=harness(a=>a.assetId==='a'?new Promise(resolve=>{finishOld=resolve;}):Promise.resolve(pixels()));t.after(()=>h.client.dispose());
 const abort=new AbortController(),one=h.client.analyze(asset('a'),{signal:abort.signal});const cancelled=assert.rejects(one,/cancelled/);abort.abort();await cancelled;
 const two=h.client.analyze(asset('b'));await turn();assert.equal(h.workers.length,1);finishOld(pixels());await turn();assert.equal(h.workers[0].posts.length,1);
 answer(h.workers[0]);assert.equal((await two).assetId,'b');
});
test('sampled shape bounds map back to source pixels while normalized outlines remain unchanged',async t=>{
 const h=harness(async()=>({pixels:{width:32,height:20,data:new Uint8ClampedArray(32*20*4)},ratio:.5}));t.after(()=>h.client.dispose());
 const result=h.client.analyze(asset('scaled'));await turn();const worker=h.workers[0],post=worker.posts[0];
 const outline=[[.2,0],[1,0],[.8,1],[0,1]];
 worker.onmessage({data:{id:post.id,candidates:[{id:'shape',kind:'control',shape:'polygon',shapeName:'parallelogram',outline,rect:{x:5,y:3,width:20,height:12},score:.95}]}});
 const value=await result;assert.deepEqual(value.candidates[0].rect,{x:10,y:6,width:40,height:24});
 assert.deepEqual(value.candidates[0].outline,outline);assert.equal(value.candidates[0].shape,'polygon');assert.equal(value.width,64);assert.equal(value.height,40);
});
test('layout font-height metadata uses source pixels while line counts remain unitless',async t=>{
 const h=harness(async()=>({pixels:{width:32,height:20,data:new Uint8ClampedArray(32*20*4)},ratio:.5}));t.after(()=>h.client.dispose());
 const result=h.client.analyze(asset('paragraph-scale'));await turn();const worker=h.workers[0];
 worker.onmessage({data:{id:worker.posts[0].id,candidates:[{id:'paragraph',kind:'paragraph',role:'paragraph',fontHeight:8,lineCount:2,rect:{x:2,y:2,width:25,height:16},score:.94}]}});
 const value=(await result).candidates[0];assert.equal(value.fontHeight,16);assert.equal(value.lineCount,2);assert.deepEqual(value.rect,{x:4,y:4,width:50,height:32});
});
test('failed active workers preserve previously completed indexes and later analyses can retry',async t=>{
 const h=harness();t.after(()=>h.client.dispose());const a=h.client.analyze(asset('a'));await turn();answer(h.workers[0]);const cached=await a;
 const b=h.client.analyze(asset('b'));const rejected=assert.rejects(b,/failed/);await turn();h.workers[0].onerror();await rejected;
 assert.equal(await h.client.analyze(asset('a')),cached);
 const retry=h.client.analyze(asset('b'));await turn();answer(h.workers[1]);assert.equal((await retry).assetId,'b');
});
test('disposal cancels active and queued work and pre-aborted requests never start decoding',async()=>{
 let decodes=0;const h=harness(()=>{decodes++;return new Promise(()=>{});});const stop=new AbortController();stop.abort();
 await assert.rejects(h.client.analyze(asset('pre'),{signal:stop.signal}),/cancelled/);assert.equal(decodes,0);
 const a=h.client.analyze(asset('a')),b=h.client.analyze(asset('b'));const ra=assert.rejects(a,/disposed/),rb=assert.rejects(b,/disposed/);
 h.client.dispose();h.client.dispose();await Promise.all([ra,rb]);assert.equal(decodes,1);
 await assert.rejects(h.client.analyze(asset('later')),/disposed/);
});
