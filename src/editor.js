function createEditor({React,ctx,NS,Icon}) {
  const EDITOR_NS=NS+'Editor';
  ctx.effect(()=>ctx.locale.register(EDITOR_NS,MESSAGES));
  const controllers=new Map(),lifetime=new AbortController(),grants=new Map();
  ctx.effect(()=>()=>{for(const c of controllers.values()){settleFeedbackText(core,c);c.dispose();}lifetime.abort();controllers.clear();});
  async function rpc(sessionId,payload,retryAuthorization=true) {
    let grant=grants.get(sessionId);
    if(!grant||grant.expiresAt<Date.now()+30000){
      const response=await fetch('/api/image-feedback/authorize?sessionId='+encodeURIComponent(sessionId),{credentials:'same-origin',signal:lifetime.signal,cache:'no-store'});
      grant=await response.json();if(!response.ok)throw new Error(grant.error||'Owner authentication required');grants.set(sessionId,grant);
    }
    if(payload.action==='submit'&&grant.reviewLabels!=='unified-v1')throw new Error(ctx.locale.bind(EDITOR_NS)('hostUpdate'));
    if(!ctx.sessions.scope(sessionId))throw new Error('Session is no longer retained');
    // Background imports and autosaves are private panel operations, not chat commands.
    // No command fallback: an older Host must report failure rather than resume log spam.
    const response=await fetch('/api/image-feedback/operations',{method:'POST',credentials:'same-origin',cache:'no-store',signal:lifetime.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({...payload,sessionId,authorization:grant.authorization})});
    let result;try{result=await response.json();}catch{throw new Error('Image Feedback background API is unavailable. Restart Harness to load the updated Host plugin.');}
    if(!response.ok&&result?.ok!==false)throw new Error('Image Feedback background operation failed ('+response.status+').');
    if(!result.ok&&result.error?.code==='OWNER_AUTH_REQUIRED'&&retryAuthorization){grants.delete(sessionId);return rpc(sessionId,payload,false);}
    if(!result.ok)throw new Error(typeof result.error==='string'?result.error:result.error?.message||result.message||'Host rejected the operation');
    return result;
  }
  function controller(sessionId) {
    if(controllers.has(sessionId))return controllers.get(sessionId);
    const key='dsh.image-feedback.recovery.v1.'+sessionId;
    const api=createSessionState({sessionId,core,rpc:payload=>rpc(sessionId,payload),recovery:{
      read:()=>{const value=localStorage.getItem(key);return value?JSON.parse(value):null;},
      write:value=>localStorage.setItem(key,JSON.stringify(value)),clear:()=>localStorage.removeItem(key)
    }});controllers.set(sessionId,api);return api;
  }
  function readFile(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(reader.error);reader.readAsDataURL(file);});}
  function loadImage(url){return new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=()=>reject(new Error('Image read failed'));image.src=url;});}
  function targetPoint(draft,note){
    const a=note.target;if(a.kind==='global')return null;if(a.kind==='point')return a.point;if(a.kind==='region')return {x:a.rect.x,y:a.rect.y};
    const block=draft.blocks.find(b=>b.id===a.blockId);if(!block)return null;
    const local=a.local?.kind==='point'?a.local.point:a.local?.kind==='region'?a.local.rect:{x:0,y:0};
    return {x:block.destination.x+local.x,y:block.destination.y+local.y};
  }
  async function renderReference(draft,asset) {
    const image=await loadImage(asset.url),canvas=document.createElement('canvas');canvas.width=draft.asset.width;canvas.height=draft.asset.height;
    const draw=canvas.getContext('2d');if(!draw)throw new Error('Canvas unavailable');draw.drawImage(image,0,0,canvas.width,canvas.height);
    // Exported evidence has a fixed, readable palette; changing the UI theme must not change its identity.
    const neutral='#f3f4f6',accent='#dc2626',label='#ffffff';
    for(const block of draft.blocks){const s=block.source;draw.clearRect(s.x,s.y,s.width,s.height);draw.fillStyle=neutral;draw.fillRect(s.x,s.y,s.width,s.height);}
    for(const block of [...draft.blocks].sort((a,b)=>a.zIndex-b.zIndex)){const s=block.source,d=block.destination;draw.drawImage(image,s.x,s.y,s.width,s.height,d.x,d.y,d.width,d.height);}
    const radius=Math.max(10,Math.min(canvas.width,canvas.height)/60);draw.lineWidth=Math.max(2,radius/5);draw.strokeStyle=accent;draw.font=`bold ${radius*1.1}px sans-serif`;draw.textAlign='center';draw.textBaseline='middle';
    for(const item of core.getReviewItems(draft)){
      const anchor=item.layout;if(!anchor)continue;
      const p=anchor.kind==='point'?anchor.point:anchor.rect;
      if(anchor.kind==='region'){const r=anchor.rect;draw.strokeRect(r.x,r.y,r.width,r.height);}
      const x=Math.max(radius,Math.min(canvas.width-radius,p.x)),y=Math.max(radius,Math.min(canvas.height-radius,p.y));
      draw.beginPath();draw.arc(x,y,radius,0,Math.PI*2);draw.fillStyle=accent;draw.fill();draw.fillStyle=label;draw.fillText(String(item.number),x,y);
    }
    return new Promise((resolve,reject)=>canvas.toBlob(async blob=>{try{if(!blob)throw new Error('Reference image encoding failed');const data=await readFile(blob);canvas.width=canvas.height=0;resolve(data);}catch(error){canvas.width=canvas.height=0;reject(error);}},'image/png'));
  }
  return createEditorView({React,ctx,EDITOR_NS,Icon,controller,rpc,readFile,targetPoint,renderReference});
}
