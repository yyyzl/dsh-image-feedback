/** Serialize only our standalone detector; no imports, network or page access in the worker. */
export function createSmartSelectionWorkerSource(engineFactory=createSmartSelectionEngine) {
  return `const engine=(${engineFactory.toString()})();self.onmessage=event=>{const {id,image,options}=event.data;try{self.postMessage({id,candidates:engine.detect(image,options)});}catch(error){self.postMessage({id,error:String(error.message||error)});}};self.postMessage({ready:true});`;
}

/** Local-only, bounded single-flight analysis. Completed results alone enter the two-image cache. */
export function createSmartSelectionClient({readPixels=null,createWorker=null}={}) {
  const cache=new Map();
  let active=null,queued=null,worker=null,workerURL=null,disposed=false,nextId=0;
  function revoke(){if(workerURL){URL.revokeObjectURL(workerURL);workerURL=null;}}
  function killWorker(){worker?.terminate();worker=null;revoke();}
  function finish(entry,error,value){
    if(entry.done)return;entry.done=true;clearTimeout(entry.timer);
    if(entry.image){entry.image.src='';entry.image=null;}
    if(entry.canvas){entry.canvas.width=entry.canvas.height=0;entry.canvas=null;}
    if(!error){cache.set(entry.key,value);while(cache.size>2)cache.delete(cache.keys().next().value);}
    for(const consumer of entry.consumers){consumer.signal?.removeEventListener('abort',consumer.abort);error?consumer.reject(error):consumer.resolve(value);}
    entry.consumers.clear();
    if(active===entry)active=null;if(queued===entry)queued=null;
    pump();
  }
  function cancel(entry,message){if(entry.done)return;if(active===entry)killWorker();finish(entry,new Error(message));}
  function ensureWorker(){
    if(disposed)throw new Error('Smart selection is disposed.');
    if(worker)return worker;
    if(!createWorker&&typeof Worker!=='function')throw new Error('Background image analysis is unavailable.');
    if(!createWorker)workerURL=URL.createObjectURL(new Blob([createSmartSelectionWorkerSource()],{type:'text/javascript'}));
    try{worker=createWorker?createWorker():new Worker(workerURL);}catch(error){revoke();throw error;}
    const target=worker;
    target.onmessage=event=>{
      if(worker!==target)return;
      if(event.data.ready){revoke();return;}
      const entry=active;if(!entry||entry.id!==event.data.id)return;
      if(event.data.error){finish(entry,new Error(event.data.error));return;}
      const sx=entry.asset.width/entry.sampleWidth,sy=entry.asset.height/entry.sampleHeight;
      const candidates=event.data.candidates.map(item=>{
        const x=Math.max(0,Math.floor(item.rect.x*sx)),y=Math.max(0,Math.floor(item.rect.y*sy));
        const right=Math.min(entry.asset.width,Math.ceil((item.rect.x+item.rect.width)*sx)),bottom=Math.min(entry.asset.height,Math.ceil((item.rect.y+item.rect.height)*sy));
        return {...item,...(Number.isFinite(item.fontHeight)?{fontHeight:item.fontHeight*sy}:{}),rect:{x,y,width:right-x,height:bottom-y}};
      }).filter(item=>item.rect.width>=2&&item.rect.height>=2);
      finish(entry,null,Object.freeze({assetId:entry.asset.assetId,width:entry.asset.width,height:entry.asset.height,candidates:Object.freeze(candidates)}));
    };
    target.onerror=()=>{if(worker!==target)return;const entry=active;killWorker();if(entry)finish(entry,new Error('Background image analysis failed.'));};
    target.onmessageerror=()=>{if(worker!==target)return;const entry=active;killWorker();if(entry)finish(entry,new Error('Background image analysis could not be read.'));};
    return worker;
  }
  async function decode(entry){
      // Decode only the already-authorized source URL; never inspect OS controls or host-page structure.
      const image=entry.image=new Image();image.decoding='async';image.src=entry.asset.url;
      await image.decode();if(entry.done||disposed)return;
      const width=image.naturalWidth,height=image.naturalHeight;
      if(width!==entry.asset.width||height!==entry.asset.height)throw new Error('Smart selection source dimensions changed.');
      const ratio=Math.min(1,1600/Math.max(width,height),Math.sqrt(1200000/(width*height)));
      const canvas=entry.canvas=document.createElement('canvas');
      canvas.width=Math.max(1,Math.round(width*ratio));canvas.height=Math.max(1,Math.round(height*ratio));
      const draw=canvas.getContext('2d',{willReadFrequently:true});if(!draw)throw new Error('Image pixels are unavailable.');
      draw.drawImage(image,0,0,canvas.width,canvas.height);
      const pixels=draw.getImageData(0,0,canvas.width,canvas.height);
      canvas.width=canvas.height=0;entry.canvas=null;image.src='';entry.image=null;
      return {pixels,ratio};
  }
  async function prepare(entry){
    try{
      const decoded=await (readPixels?readPixels(entry.asset):decode(entry));
      if(entry.done||disposed)return;
      const {pixels,ratio}=decoded;entry.sampleWidth=pixels.width;entry.sampleHeight=pixels.height;
      const target=ensureWorker();
      target.postMessage({id:entry.id,image:{width:pixels.width,height:pixels.height,data:pixels.data},options:{scale:Math.max(.25,ratio)}},[pixels.data.buffer]);
    }catch(error){if(!entry.done)finish(entry,error);}
  }
  function pump(){
    if(disposed||active||!queued)return;
    active=queued;queued=null;const entry=active;
    // The deadline starts at admission, never while waiting behind another image.
    entry.timer=setTimeout(()=>cancel(entry,'Background image analysis exceeded its time limit.'),8000);
    prepare(entry);
  }
  return {
    analyze(asset,{signal}={}){
      if(disposed)return Promise.reject(new Error('Smart selection is disposed.'));
      if(signal?.aborted)return Promise.reject(new Error('Smart selection was cancelled.'));
      if(!asset?.url||!asset.assetId||!Number.isInteger(asset.width)||!Number.isInteger(asset.height)||asset.width<1||asset.height<1)return Promise.reject(new Error('Load a valid image first.'));
      const key=['smart-raster-v2-layout',asset.assetId,asset.url,asset.width,asset.height].join('\n');
      if(cache.has(key))return Promise.resolve(cache.get(key));
      let entry=active?.key===key?active:queued?.key===key?queued:null;
      if(!entry){
        if(queued){const previous=queued;queued=null;finish(previous,new Error('A newer image superseded queued analysis.'));}
        entry={id:++nextId,key,asset:{...asset},consumers:new Set(),done:false};queued=entry;
      }
      const result=new Promise((resolve,reject)=>{
        const consumer={resolve,reject,signal,abort:null};
        consumer.abort=()=>{
          signal?.removeEventListener('abort',consumer.abort);entry.consumers.delete(consumer);reject(new Error('Smart selection was cancelled.'));
          if(!entry.consumers.size)cancel(entry,'Smart selection was cancelled.');
        };
        entry.consumers.add(consumer);signal?.addEventListener('abort',consumer.abort,{once:true});
        if(signal?.aborted)consumer.abort();
      });
      pump();return result;
    },
    dispose(){
      if(disposed)return;disposed=true;killWorker();cache.clear();
      if(queued)cancel(queued,'Smart selection is disposed.');
      if(active)cancel(active,'Smart selection is disposed.');
    }
  };
}
