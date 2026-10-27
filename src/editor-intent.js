/** Pure view helpers. Zoom never mutates a draft or consumes an undo step. */
// 仅接管反馈编辑器的撤销；路径框等普通输入保留浏览器文字操作。
export function feedbackShortcut(event,{editable=false,editingNote=false}={}) {
  if(event.defaultPrevented||event.isComposing||event.nativeEvent?.isComposing||event.altKey||!(event.ctrlKey||event.metaKey))return null;
  const key=event.key.toLowerCase();
  if(key==='n'&&!event.shiftKey)return 'new';
  if(editable&&!editingNote)return null;
  if(key==='z')return event.shiftKey?'redo':'undo';
  if(key==='y'&&!event.shiftKey)return 'redo';
  return null;
}

export function wheelZoomScale(scale,deltaY,deltaMode=0,viewportHeight=600,pinch=false) {
  if(![scale,deltaY,viewportHeight].every(Number.isFinite)||scale<=0)return scale;
  const pixels=deltaY*(deltaMode===1?16:deltaMode===2?Math.max(1,viewportHeight):1);
  return Math.max(.02,Math.min(8,scale*Math.exp(-Math.max(-240,Math.min(240,pixels))*(pinch ? .01 : .002))));
}
export function anchoredZoomPlan({width,height,viewportWidth,viewportHeight,scale,nextScale,scrollLeft=0,scrollTop=0,x,y,padding=20,anchor=null}) {
  if(![width,height,viewportWidth,viewportHeight,scale,nextScale,scrollLeft,scrollTop,x,y,padding].every(Number.isFinite)||scale<=0||nextScale<=0)throw new Error('Invalid zoom geometry');
  const next=Math.max(.02,Math.min(8,nextScale));
  if(anchor!==null&&![anchor.x,anchor.y].every(Number.isFinite))throw new Error('Invalid zoom anchor');
  function axis(size,viewport,scroll,point,fixed){
    const origin=Math.max(padding,(viewport-size*scale)/2),assetPoint=fixed??(scroll+point-origin)/scale;
    const newOrigin=Math.max(padding,(viewport-size*next)/2),maximum=Math.max(0,size*next+2*padding-viewport);
    return {anchor:assetPoint,scroll:Math.max(0,Math.min(maximum,newOrigin+assetPoint*next-point))};
  }
  const horizontal=axis(width,viewportWidth,scrollLeft,x,anchor?.x),vertical=axis(height,viewportHeight,scrollTop,y,anchor?.y);
  return {scale:next,scrollLeft:horizontal.scroll,scrollTop:vertical.scroll,point:{x:horizontal.anchor,y:vertical.anchor}};
}

/** Pure direct-edit interaction rules; selecting a block never creates an empty comment. */
export function settleFeedbackText(core,controller,noteId=null) {
  const state=controller.getSnapshot();
  if(!controller.getTextEditKey()||!state.draft)return;
  const baseline=state.history.current;
  // Blank newly staged notes are transient UI, not permanent feedback.
  if(state.draft.annotations.some(note=>!note.text.trim()&&!baseline.annotations.some(old=>old.id===note.id))){controller.cancelTextEdit();return;}
  const note=state.draft.annotations.find(item=>item.id===noteId);
  if(note&&note.text!==note.text.trim())controller.previewText(core.updateAnnotation(state.draft,note.id,{text:note.text.trim()}));
  controller.finishTextEdit();
}
export function selectionIntent({tool='select',blockId=null,noteId=null,noteKind=null,noteLocalKind=null,forceNew=false}={}) {
  if(tool==='pan')return 'pan';
  if(noteId&&!forceNew){
    if((tool==='select'||tool==='point')&&(noteKind==='point'||(noteKind==='block'&&noteLocalKind==='point')))return 'move-point';
    return tool==='select'&&noteKind==='region'?'move-region':'edit-note';
  }
  if(tool==='point')return 'point';
  if(blockId&&!forceNew)return 'move-block';
  return 'draw-region';
}
export function selectionRectangle(start,end,scale=1) {
  if(Math.hypot(end.x-start.x,end.y-start.y)*scale<4)return null;
  const x=Math.round(Math.min(start.x,end.x)),y=Math.round(Math.min(start.y,end.y));
  const rect={x,y,width:Math.round(Math.max(start.x,end.x))-x,height:Math.round(Math.max(start.y,end.y))-y};
  return rect.width>=2&&rect.height>=2?rect:null;
}
/** Filter layout ownership once per immutable block list, never once per mouse event. */
export function prepareSmartHoverIndex(core,draft,index) {
  if(!draft||!index||index.assetId!==draft.asset.assetId||index.width!==draft.asset.width||index.height!==draft.asset.height)return null;
  if(index.blocks===draft.blocks)return index;
  const overlap=(a,b)=>a.x<b.x+b.width&&b.x<a.x+a.width&&a.y<b.y+b.height&&b.y<a.y+a.height;
  const candidates=index.candidates.filter(item=>{
    const r=item.rect;
    return r&&['x','y','width','height'].every(key=>Number.isFinite(r[key]))&&r.width>=2&&r.height>=2&&r.x>=0&&r.y>=0&&r.x+r.width<=index.width&&r.y+r.height<=index.height&&!draft.blocks.some(block=>overlap(r,block.source)||overlap(r,block.destination));
  });
  return {...index,candidates,blocks:draft.blocks};
}
/** Preview-only hit testing. No draft validation, pixel scan or geometry rebuilding on pointermove. */
export function smartHoverCandidate(core,engine,draft,index,position,previous=null) {
  if(!draft||!index||index.assetId!==draft.asset.assetId||index.width!==draft.asset.width||index.height!==draft.asset.height)return null;
  if(!position||!Number.isFinite(position.x)||!Number.isFinite(position.y)||position.x<0||position.y<0||position.x>=index.width||position.y>=index.height)return null;
  const prepared=prepareSmartHoverIndex(core,draft,index);
  return prepared?engine.pick(prepared.candidates,position,previous):null;
}
export function selectionGestureCurrent(gesture,controller,sessionId) {
  const now=controller.getSnapshot();
  return !!gesture&&gesture.owner===controller&&gesture.sessionId===sessionId&&gesture.history===now.history&&!!now.draft&&gesture.assetId===now.draft.asset.assetId&&(gesture.kind==='pan'||gesture.version===now.history.version);
}
/** Convert optional shape metadata into a bounded, non-interactive SVG geometry. */
export function smartSelectionOutline(candidate) {
  const r=candidate?.rect;
  if(!r||!['x','y','width','height'].every(key=>Number.isFinite(r[key]))||r.width<=0||r.height<=0)return null;
  const rect={x:r.x,y:r.y,width:r.width,height:r.height};
  if(candidate.shape==='ellipse')return {tag:'ellipse',attrs:{cx:r.x+r.width/2,cy:r.y+r.height/2,rx:r.width/2,ry:r.height/2}};
  if(candidate.shape==='capsule')return {tag:'rect',attrs:{...rect,rx:Math.min(r.width,r.height)/2}};
  if(candidate.shape==='polygon'&&Array.isArray(candidate.outline)&&candidate.outline.length>=3&&candidate.outline.length<=8&&candidate.outline.every(p=>Array.isArray(p)&&p.length===2&&p.every(n=>Number.isFinite(n)&&n>=0&&n<=1)))return {tag:'polygon',attrs:{points:candidate.outline.map(([u,v])=>(r.x+u*r.width)+','+(r.y+v*r.height)).join(' ')}};
  return {tag:'rect',attrs:rect};
}
/** A preview is only a click shortcut: once a manual drag starts it can never snap back. */
export function selectionGestureResult(start,end,scale,candidate=null,manual=false) {
  const rect=selectionRectangle(start,end,scale);
  if(rect)return rect;
  if(manual||Math.hypot(end.x-start.x,end.y-start.y)*scale>=4)return null;
  const r=candidate?.rect;
  if(!r||!['x','y','width','height'].every(key=>Number.isFinite(r[key]))||r.width<2||r.height<2)return null;
  return {x:r.x,y:r.y,width:r.width,height:r.height};
}

/** Move only a point anchor in layout pixels; its free/local binding and all image blocks stay unchanged. */
export function movePointAnnotation(core,draft,noteId,layoutPoint) {
  const current=core.validateDraft(draft),note=current.annotations.find(item=>item.id===noteId);
  if(!note)throw new core.CoreError('MISSING_ANNOTATION','Select an existing point annotation before moving it.');
  const target=note.target,local=target.kind==='block'&&target.local?.kind==='point';
  if(target.kind!=='point'&&!local)throw new core.CoreError('INVALID_DRAFT','Only point annotations can be moved with a point gesture.');
  // Identity transform shares the core's strict finite {x,y} validation without changing coordinates.
  const position=core.viewToAsset(layoutPoint,{scale:1});
  const clamp=(value,size)=>Math.max(0,Math.min(Math.max(0,size-1),value));
  let nextTarget,blockId;
  if(local){
    blockId=target.blockId;
    const block=current.blocks.find(item=>item.id===blockId);
    const point={x:clamp(position.x-block.destination.x,block.source.width),y:clamp(position.y-block.destination.y,block.source.height)};
    nextTarget={...target,local:{...target.local,point}};
  }else{
    nextTarget={...target,point:{x:clamp(position.x,current.asset.width),y:clamp(position.y,current.asset.height)}};
  }
  const result={draft:core.updateAnnotation(current,noteId,{target:nextTarget}),noteId};
  if(blockId!==undefined)result.blockId=blockId;
  return result;
}
/** Validate before settling text; a newly staged blank point keeps creation+move+typing in one group. */
export function commitPointMove(core,controller,noteId,layoutPoint) {
  const state=controller.getSnapshot();
  if(!state.draft||!state.history)throw new Error('Load an image before moving a point annotation.');
  const checked=movePointAnnotation(core,state.draft,noteId,layoutPoint);
  const note=state.draft.annotations.find(item=>item.id===noteId);
  const freshBlank=Boolean(controller.getTextEditKey()&&!note.text.trim()&&!state.history.current.annotations.some(item=>item.id===noteId));
  if(freshBlank)controller.previewText(checked.draft);
  else{controller.finishTextEdit();controller.commit(checked.draft);}
  return {...checked,draft:controller.getSnapshot().draft};
}
export function promoteRegion(core,draft,noteId) {
  const note=draft.annotations.find(n=>n.id===noteId);
  if(!note||note.target.kind!=='region')throw new Error('Select a rectangle annotation before moving its pixels.');
  const rect=note.target.rect;
  // Exact visible frames refer to an existing component, not a second cut of its pixels.
  // Core drafts are ordered bottom-to-top; match the same topmost block as hitTest.
  const existing=[...draft.blocks].reverse().find(block=>['x','y','width','height'].every(key=>block.destination[key]===rect[key]));
  if(existing)return {draft:core.updateAnnotation(draft,noteId,{target:{kind:'block',blockId:existing.id}}),blockId:existing.id};
  // Only source ownership must be disjoint. Layout destinations may overlap freely.
  if(draft.blocks.some(block=>core.rectanglesOverlap(rect,block.source)))throw new Error('This region overlaps already-owned source pixels. Select that block or draw a separate region; the original pixels have not been changed.');
  const next=core.addBlock(draft,rect),blockId=next.blocks[next.blocks.length-1].id;
  return {draft:core.updateAnnotation(next,noteId,{target:{kind:'block',blockId}}),blockId};
}
/** Cut and optionally move a selected frame in one history step; destination is absolute and clamped. */
export function promoteSelectedRegion(core,controller,noteId,destination) {
  const state=controller.getSnapshot(),note=state.draft?.annotations.find(n=>n.id===noteId);
  if(!state.draft||!state.history)throw new Error('Load an image before moving its pixels.');
  // Build every candidate before settling input: invalid cuts or coordinates must retain pending text.
  const checked=promoteRegion(core,state.draft,noteId);
  const freshBlank=Boolean(controller.getTextEditKey()&&note&&!note.text.trim()&&!state.history.current.annotations.some(n=>n.id===noteId));
  let draft=checked.draft,blockId=checked.blockId;
  if(freshBlank){
    const baseline=state.history.current;
    if(state.draft.blocks.some(block=>block.id===blockId)){
      if(!baseline.blocks.some(block=>block.id===blockId))throw new Error('Finish creating the selected block before moving it.');
      draft=baseline;
    }else{
      draft=core.addBlock(baseline,note.target.rect);
      blockId=draft.blocks[draft.blocks.length-1].id;
    }
  }
  if(destination!==undefined)draft=core.moveBlock(draft,blockId,destination,{bounds:'clamp'});
  if(freshBlank)controller.cancelTextEdit();
  else controller.finishTextEdit();
  controller.commit(draft);
  return {draft:controller.getSnapshot().draft,blockId,noteId:freshBlank?null:noteId};
}
export function blockComment(draft, blockId, selectedNoteId) {
  const selected=draft.annotations.find(note=>note.id===selectedNoteId);
  if(selected?.target.kind==='block'&&selected.target.blockId===blockId)return selected;
  return draft.annotations.find(note=>note.target.kind==='block'&&note.target.blockId===blockId&&!note.target.local)||null;
}
export function writeBlockComment(core,draft,blockId,text,selectedNoteId) {
  const note=blockComment(draft,blockId,selectedNoteId);
  if(note)return {draft:core.updateAnnotation(draft,note.id,{text}),noteId:note.id};
  if(!text.length)return {draft,noteId:null};
  const next=core.addAnnotation(draft,{text,target:{kind:'block',blockId}});
  return {draft:next,noteId:next.annotations[next.annotations.length-1].id};
}
