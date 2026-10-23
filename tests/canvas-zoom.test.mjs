import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {wheelZoomScale,anchoredZoomPlan} from '../src/editor-intent.js';
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);
const base={width:1200,height:800,viewportWidth:400,viewportHeight:300,scale:1,nextScale:2,scrollLeft:250,scrollTop:150,x:130,y:90};
test('mouse wheel zoom direction, pinch, normalized modes and bounds are finite',()=>{
 assert.ok(wheelZoomScale(1,-100)>1);assert.ok(wheelZoomScale(1,100)<1);
 near(wheelZoomScale(1,3,1),wheelZoomScale(1,48,0));
 near(wheelZoomScale(1,.1,2,600),wheelZoomScale(1,60));
 assert.ok(wheelZoomScale(1,-5,0,600,true)>wheelZoomScale(1,-5));
 assert.equal(wheelZoomScale(.02,1000),.02);assert.equal(wheelZoomScale(8,-1000),8);
 assert.equal(wheelZoomScale(1,NaN),1);assert.equal(wheelZoomScale(1,0),1);
});
test('zoom keeps the asset point under the same pointer when both axes can scroll',()=>{
 const p=anchoredZoomPlan(base);
 near(20-p.scrollLeft+p.point.x*p.scale,base.x);
 near(20-p.scrollTop+p.point.y*p.scale,base.y);
 const back=anchoredZoomPlan({...base,scale:p.scale,nextScale:1,scrollLeft:p.scrollLeft,scrollTop:p.scrollTop});
 near(back.scrollLeft,base.scrollLeft);near(back.scrollTop,base.scrollTop);
});
test('centered images cross into overflow without incorrectly assuming a fixed padding origin',()=>{
 const p=anchoredZoomPlan({...base,width:200,height:100,viewportWidth:400,viewportHeight:300,scale:1,nextScale:4,scrollLeft:0,scrollTop:0,x:200,y:150});
 near(p.point.x,100);near(p.point.y,50);
 near(p.scrollLeft,220);near(p.scrollTop,70);
});
test('small images and edges clamp gracefully while the other axis stays anchored',()=>{
 const p=anchoredZoomPlan({...base,width:100,height:800,x:10});
 assert.equal(p.scrollLeft,0);near(20-p.scrollTop+p.point.y*p.scale,base.y);
 const small=anchoredZoomPlan({...base,width:100,height:80,scale:1,nextScale:.5,scrollLeft:0,scrollTop:0});
 assert.equal(small.scrollLeft,0);assert.equal(small.scrollTop,0);
 const bounded=anchoredZoomPlan({...base,nextScale:99});assert.equal(bounded.scale,8);
 assert.throws(()=>anchoredZoomPlan({...base,nextScale:NaN}),/Invalid zoom/);
});
test('coalesced wheel plans use pending geometry rather than stale DOM scale',()=>{
 const first=anchoredZoomPlan({...base,nextScale:1.2});
 const second=anchoredZoomPlan({...base,scale:first.scale,nextScale:1.5,scrollLeft:first.scrollLeft,scrollTop:first.scrollTop});
 const direct=anchoredZoomPlan({...base,nextScale:1.5});
 near(second.scrollLeft,direct.scrollLeft);near(second.scrollTop,direct.scrollTop);
});
test('native wheel and Safari gesture handlers stay local, non-passive, and disposable',async()=>{
 const view=await readFile(new URL('../src/editor-view.js',import.meta.url),'utf8');
 assert.match(view,/options=\{passive:false\}/);
 for(const type of ['wheel','gesturestart','gesturechange','gestureend']){
  assert.ok(view.includes(`stage.addEventListener('${type}'`));assert.ok(view.includes(`stage.removeEventListener('${type}'`));
 }
 assert.doesNotMatch(view,/(?:document|window).addEventListener\(/);
 assert.match(view,/if\(pointer.current\|\|nativeGesture.current\)return/);
 assert.match(view,/getScreenCTM\(\)/);assert.match(view,/React.useLayoutEffect/);
 assert.match(view,/gesture.scale\*event.scale/);
});
