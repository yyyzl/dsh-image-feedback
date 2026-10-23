import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {once} from 'node:events';
import {createSmartSelectionEngine} from '../src/smart-selection.js';
import {createSmartSelectionWorkerSource} from '../src/smart-selection-client.js';

test('production detector program runs in a real isolated worker, transfers pixels, and correlates responses',async t=>{
 const program=createSmartSelectionWorkerSource(createSmartSelectionEngine);
 assert.doesNotMatch(program,/\bimport\b|\bfetch\s*\(|document\./);
 const worker=new Worker(`const {parentPort}=require('node:worker_threads');globalThis.self={postMessage:value=>parentPort.postMessage(value)};${program};parentPort.on('message',data=>self.onmessage({data}));`,{eval:true});
 t.after(()=>worker.terminate());
 const ready=await once(worker,'message');assert.equal(ready[0].ready,true);
 const width=160,height=100,data=new Uint8ClampedArray(width*height*4);data.fill(255);
 for(let y=30;y<60;y++)for(let x=30;x<120;x++){const i=(y*width+x)*4;data[i]=35;data[i+1]=95;data[i+2]=210;}
 const reply=once(worker,'message');worker.postMessage({id:17,image:{width,height,data}},[data.buffer]);
 assert.equal(data.byteLength,0,'the source pixel buffer is transferred rather than copied at submission');
 const [result]=await reply;assert.equal(result.id,17);assert.ok(Array.isArray(result.candidates));
 assert.ok(result.candidates.some(item=>Math.abs(item.rect.x-30)<=3&&Math.abs(item.rect.y-30)<=3&&Math.abs(item.rect.width-90)<=6&&Math.abs(item.rect.height-30)<=6));
 const invalid=once(worker,'message');worker.postMessage({id:18,image:{width:160,height:100,data:new Uint8ClampedArray(4)}});
 const [error]=await invalid;assert.equal(error.id,18);assert.equal(typeof error.error,'string');
 const after=once(worker,'message');worker.postMessage({id:19,image:{width:12,height:12,data:new Uint8ClampedArray(12*12*4)}});
 assert.equal((await after)[0].id,19,'invalid image data does not kill the worker for future requests');
});
