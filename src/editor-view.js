/* Native sidebar view. Only the image canvas consumes gestures; no document listeners. */
function createEditorView({React,ctx,EDITOR_NS,Icon,controller,rpc,readFile,targetPoint,renderReference,smartSelection}) {
  const h=React.createElement;
  const settleText=c=>settleFeedbackText(core,c);
  const paths={
    select:'M5 3l14 10-7 1-3 7z',layout:'M4 9V4h5m6 0h5v5m0 6v5h-5m-6 0H4v-5M9 9h6v6H9z',
    point:'M12 21s6-6.6 6-12a6 6 0 0 0-12 0c0 5.4 6 12 6 12zM12 7v4m-2-2h4',
    pan:'M8 12V6a2 2 0 0 1 4 0v6m0-4a2 2 0 0 1 4 0v5m0-3a2 2 0 0 1 4 0v5c0 4-2 6-6 6h-1c-2 0-3-1-4-3l-4-5a2 2 0 0 1 3-2l3 3',
    undo:'M8 5L3 10l5 5M3 10h11a6 6 0 0 1 0 12',redo:'M16 5l5 5-5 5m5-5H10a6 6 0 0 0 0 12',
    fit:'M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5',plus:'M12 5v14M5 12h14',minus:'M5 12h14',
    trash:'M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6m4-6v6',reset:'M4 10a8 8 0 1 1 1 8M4 4v6h6',
    send:'M21 3L3 10l7 4 4 7zM10 14L21 3',more:'M5 12h.01M12 12h.01M19 12h.01',
    image:'M3 4h18v16H3zM3 16l6-6 5 5 3-3 4 4M16 8h.01',note:'M4 4h16v12H9l-5 4zM8 8h8m-8 4h5',
    close:'M6 6l12 12M6 18L18 6',download:'M12 3v12m-4-4l4 4 4-4M4 16v5h16v-5',chevron:'M9 5l7 7-7 7',check:'M5 12l4 4L19 6'
  };
  const glyph=name=>h('svg',{className:'dif-icon',viewBox:'0 0 24 24',width:18,height:18,fill:'none',stroke:'currentColor',strokeWidth:1.6,strokeLinecap:'round',strokeLinejoin:'round','aria-hidden':true},h('path',{d:paths[name]||paths.note}));
  const emptyArtwork=()=>h('svg',{className:'dif-empty-art',viewBox:'0 0 190 130',fill:'none','aria-hidden':true},
    h('rect',{className:'dif-art-back',x:30,y:12,width:130,height:94,rx:9,transform:'rotate(-6 95 59)'}),
    h('rect',{className:'dif-art-sheet',x:22,y:22,width:140,height:94,rx:8}),
    h('circle',{cx:33,cy:32,r:2,fill:'currentColor',opacity:.35}),h('circle',{cx:40,cy:32,r:2,fill:'currentColor',opacity:.2}),
    h('path',{d:'M23 41H161',stroke:'currentColor',opacity:.15}),
    h('rect',{className:'dif-art-skeleton',x:33,y:51,width:42,height:52,rx:4}),
    h('rect',{className:'dif-art-skeleton',x:86,y:53,width:50,height:5,rx:2.5}),
    h('rect',{className:'dif-art-skeleton',x:86,y:65,width:61,height:4,rx:2}),
    h('rect',{className:'dif-art-skeleton',x:86,y:75,width:40,height:4,rx:2}),
    h('rect',{className:'dif-art-skeleton',x:86,y:91,width:29,height:12,rx:3}),
    h('rect',{className:'dif-art-selection',x:80,y:46,width:74,height:39,rx:3}),
    h('circle',{className:'dif-art-pin',cx:154,cy:46,r:10}),
    h('text',{className:'dif-art-number',x:154,y:46,textAnchor:'middle',dominantBaseline:'central'},'1'),
    h('path',{d:'m132 95 4 18 4-6 7-2z',fill:'var(--dsw-alias-label-primary)',stroke:'var(--dsw-alias-bg-base)',strokeWidth:1.5}));
  return function Editor(props) {
    React.useSyncExternalStore(fn=>ctx.locale.subscribe(fn),()=>ctx.locale.getSnapshot());
    const t=ctx.locale.bind(EDITOR_NS),c=React.useMemo(()=>controller(props.sessionId),[props.sessionId]);
    const state=React.useSyncExternalStore(c.subscribe,c.getSnapshot),{draft,asset}=state;
    const inputPhase=props.useInput(input=>input.phase);
    const [tool,setTool]=React.useState('select'),[selected,setSelected]=React.useState(null),[selectedNote,setSelectedNote]=React.useState(null);
    const [zoom,setZoom]=React.useState(null),[boxSize,setBoxSize]=React.useState({width:500,height:320});
    const [transient,setTransient]=React.useState(null),[busy,setBusy]=React.useState(false),[notice,setNotice]=React.useState('');
    const [library,setLibrary]=React.useState(null),[pathOpen,setPathOpen]=React.useState(false),[pathValue,setPathValue]=React.useState('');
    const [confirmation,setConfirmation]=React.useState(null),[focusRequest,setFocusRequest]=React.useState(0);
    const [compactHeight,setCompactHeight]=React.useState(false),[fileHover,setFileHover]=React.useState(false),[panning,setPanning]=React.useState(false);
    const [smartEnabled,setSmartEnabled]=React.useState(true),[smartScan,setSmartScan]=React.useState(null),[smartHover,setSmartHover]=React.useState(null);
    const smartEngine=React.useMemo(()=>createSmartSelectionEngine(),[]),hoverPoint=React.useRef(null),hoverCandidate=React.useRef(null);
    const rootRef=React.useRef(null),notesScrollRef=React.useRef(null),confirmationRef=React.useRef(null),dragDepth=React.useRef(0);
    // Reveal only inside our own two scrollports; never scroll the chat or shell.
    function revealInEditor(target){
      if(!target)return;
      for(const scroll of [notesScrollRef.current,rootRef.current]){
        if(!scroll?.contains(target))continue;
        const r=target.getBoundingClientRect(),box=scroll.getBoundingClientRect(),top=box.top+scroll.clientTop,bottom=top+scroll.clientHeight;
        if(r.top<top||r.height>scroll.clientHeight)scroll.scrollTop+=r.top-top;
        else if(r.bottom>bottom)scroll.scrollTop+=r.bottom-bottom;
      }
    }
    const svgRef=React.useRef(null),stageRef=React.useRef(null),fileRef=React.useRef(null),editorRef=React.useRef(null),menuRef=React.useRef(null);
    const pointer=React.useRef(null),busyRef=React.useRef(false),alive=React.useRef(true),space=React.useRef(false);
    const zoomIO=React.useRef(null),pendingZoom=React.useRef(null),nativeGesture=React.useRef(null),wheelGesture=React.useRef(null),wheelTimer=React.useRef(null);
    const clipId=React.useId().replace(/:/g,'')+'-dif';
    React.useEffect(()=>{alive.current=true;c.ensureLoaded();return()=>{alive.current=false;settleText(c);c.flush().catch(()=>{});};},[c]);
    React.useEffect(()=>{const stage=stageRef.current;if(!stage)return;const observer=new ResizeObserver(entries=>{const r=entries[0].contentRect;setBoxSize({width:r.width,height:r.height});});observer.observe(stage);return()=>observer.disconnect();},[!!draft]);
    React.useEffect(()=>{if(focusRequest){editorRef.current?.focus({preventScroll:true});revealInEditor(editorRef.current);}},[focusRequest]);
    React.useEffect(()=>{
      if(!confirmation)return;
      const previous=document.activeElement;
      confirmationRef.current?.focus({preventScroll:true});revealInEditor(confirmationRef.current);
      return()=>{if(previous?.isConnected&&rootRef.current?.contains(previous)){previous.focus({preventScroll:true});revealInEditor(previous);}};
    },[confirmation]);
    React.useEffect(()=>{const root=rootRef.current;if(!root)return;const observer=new ResizeObserver(entries=>setCompactHeight(entries[0].contentRect.height<480));observer.observe(root);return()=>observer.disconnect();},[]);
    const scale=draft?Math.max(.02,zoom??Math.min((boxSize.width-40)/draft.asset.width,(boxSize.height-40)/draft.asset.height,1)):1;
    const marker=10/Math.max(.05,scale),block=draft?.blocks.find(b=>b.id===selected);
    const activeNote=draft&&(block?blockComment(draft,block.id,selectedNote):draft.annotations.find(n=>n.id===selectedNote));
    const showDraft=(transient?.kind==='region-move'||transient?.kind==='point-move')?transient.draft:draft&&transient?.kind==='move'?{...draft,blocks:draft.blocks.map(b=>b.id===transient.id?{...b,destination:{...b.destination,...transient.point}}:b)}:draft;
    const displaySelected=transient?.kind==='region-move'?transient.blockId:selected;
    const moves=React.useMemo(()=>draft?core.getMoves(draft):[],[draft]);
    const items=React.useMemo(()=>draft?core.getReviewItems(draft):[],[draft]);
    const displayItems=React.useMemo(()=>showDraft===draft?items:showDraft?core.getReviewItems(showDraft):[],[showDraft,items]),isLocked=busy||state.sending;
    const activeItem=items.find(item=>activeNote?item.annotationId===activeNote.id:block&&item.key==='block:'+block.id)||null;
    const sourceSmartIndex=draft&&smartScan&&smartScan.assetId===draft.asset.assetId?smartScan.index:null;
    const smartIndex=React.useMemo(()=>prepareSmartHoverIndex(core,draft,sourceSmartIndex),[sourceSmartIndex,draft?.blocks]);
    const smartPreview=draft&&smartHover&&smartEnabled&&tool==='select'&&!isLocked&&!pointer.current&&smartHover.assetId===draft.asset.assetId?smartHover.candidate:null;
    const smartGeometry=smartSelectionOutline(smartPreview);
    function clearSmartHover(){hoverPoint.current=null;hoverCandidate.current=null;setSmartHover(null);}
    React.useEffect(()=>{
      let current=true;clearSmartHover();
      if(!draft||!asset||!smartEnabled){setSmartScan(null);return;}
      const assetId=draft.asset.assetId,stop=new AbortController();setSmartScan({assetId,status:'loading',index:null});
      smartSelection.analyze({...asset,width:draft.asset.width,height:draft.asset.height},{signal:stop.signal}).then(index=>{if(current)setSmartScan({assetId,status:'ready',index});}).catch(()=>{if(current)setSmartScan({assetId,status:'unavailable',index:null});});
      return()=>{current=false;stop.abort();};
    },[draft?.asset.assetId,asset?.url,smartEnabled]);
    React.useEffect(()=>{
      const p=hoverPoint.current;
      if(!p||tool!=='select'||!smartEnabled||isLocked||pointer.current)return;
      const candidate=smartHoverCandidate(core,smartEngine,draft,smartIndex,p);
      hoverCandidate.current=candidate;setSmartHover(candidate?{assetId:draft.asset.assetId,candidate}:null);
    },[smartIndex]);
    React.useEffect(()=>{clearSmartHover();},[tool,smartEnabled,isLocked,c,state.history,draft,scale]);
    React.useEffect(()=>{cancelPointer();},[c,draft?.asset.assetId,state.history]);
    const editKey=block?'block:'+block.id:activeNote?'note:'+activeNote.id:null;
    function clearWheelGesture(){if(wheelTimer.current!==null)clearTimeout(wheelTimer.current);wheelTimer.current=null;wheelGesture.current=null;}
    function viewCenter(){const stage=stageRef.current,r=stage.getBoundingClientRect();return {x:r.left+stage.clientLeft+stage.clientWidth/2,y:r.top+stage.clientTop+stage.clientHeight/2};}
    function screenAnchor(client){const svg=svgRef.current,matrix=svg?.getScreenCTM();if(!matrix)return null;const p=svg.createSVGPoint();p.x=client.x;p.y=client.y;const result=p.matrixTransform(matrix.inverse());return {x:result.x,y:result.y};}
    function correctAnchor(point,client){const svg=svgRef.current,stage=stageRef.current,matrix=svg?.getScreenCTM();if(!matrix||!stage)return;const p=svg.createSVGPoint();p.x=point.x;p.y=point.y;const result=p.matrixTransform(matrix);stage.scrollLeft+=result.x-client.x;stage.scrollTop+=result.y-client.y;}
    function zoomTo(value,client=viewCenter(),fixedPoint=null){
      const stage=stageRef.current;if(!draft||!stage||!Number.isFinite(value))return;if(!fixedPoint)clearWheelGesture();
      const pending=pendingZoom.current,current=pending?.scale??scale,next=Math.max(.02,Math.min(8,value));
      if(next===current&&!fixedPoint)return;
      const r=stage.getBoundingClientRect(),plan=anchoredZoomPlan({width:draft.asset.width,height:draft.asset.height,viewportWidth:stage.clientWidth,viewportHeight:stage.clientHeight,scale:current,nextScale:next,scrollLeft:pending?.scrollLeft??stage.scrollLeft,scrollTop:pending?.scrollTop??stage.scrollTop,x:client.x-r.left-stage.clientLeft,y:client.y-r.top-stage.clientTop,anchor:fixedPoint});
      const point=fixedPoint||(pending?plan.point:screenAnchor(client));if(!point)return;
      if(next===scale){pendingZoom.current=null;correctAnchor(point,client);setZoom(next);return;}
      pendingZoom.current={...plan,point,client};setZoom(next);
    }
    zoomIO.current={
      wheel:event=>{
        if(!draft||isLocked)return;
        if(!event.ctrlKey&&(event.shiftKey||Math.abs(event.deltaX)>Math.abs(event.deltaY)))return;
        event.preventDefault();event.stopPropagation();
        if(pointer.current||nativeGesture.current)return;
        const client={x:event.clientX,y:event.clientY};let gesture=wheelGesture.current;
        if(!gesture||gesture.pinch!==event.ctrlKey||(!event.ctrlKey&&Math.hypot(client.x-gesture.client.x,client.y-gesture.client.y)>4)){
          gesture={point:screenAnchor(client),client,pinch:event.ctrlKey};wheelGesture.current=gesture;
        }
        if(!gesture.point)return;
        if(wheelTimer.current!==null)clearTimeout(wheelTimer.current);
        wheelTimer.current=setTimeout(()=>{wheelGesture.current=null;wheelTimer.current=null;},250);
        zoomTo(wheelZoomScale(pendingZoom.current?.scale??scale,event.deltaY,event.deltaMode,stageRef.current.clientHeight,event.ctrlKey),client,gesture.point);
      },
      start:event=>{if(!draft||isLocked||pointer.current)return;clearWheelGesture();event.preventDefault();event.stopPropagation();const client=Number.isFinite(event.clientX)&&Number.isFinite(event.clientY)?{x:event.clientX,y:event.clientY}:viewCenter();nativeGesture.current={scale:pendingZoom.current?.scale??scale,point:screenAnchor(client),client};},
      change:event=>{const gesture=nativeGesture.current;if(!gesture)return;event.preventDefault();event.stopPropagation();if(isLocked||pointer.current||!Number.isFinite(event.scale)||event.scale<=0)return;const client=Number.isFinite(event.clientX)&&Number.isFinite(event.clientY)?{x:event.clientX,y:event.clientY}:gesture.client;zoomTo(gesture.scale*event.scale,client,gesture.point);},
      end:event=>{if(nativeGesture.current){event.preventDefault();event.stopPropagation();nativeGesture.current=null;}}
    };
    React.useLayoutEffect(()=>{const pending=pendingZoom.current,stage=stageRef.current;if(!pending||pending.scale!==scale||!stage)return;stage.scrollLeft=pending.scrollLeft;stage.scrollTop=pending.scrollTop;correctAnchor(pending.point,pending.client);pendingZoom.current=null;},[scale]);
    React.useEffect(()=>{
      const stage=stageRef.current;if(!stage||!draft)return;
      const wheel=e=>zoomIO.current.wheel(e),start=e=>zoomIO.current.start(e),change=e=>zoomIO.current.change(e),end=e=>zoomIO.current.end(e),options={passive:false};
      stage.addEventListener('wheel',wheel,options);stage.addEventListener('gesturestart',start,options);stage.addEventListener('gesturechange',change,options);stage.addEventListener('gestureend',end,options);
      return()=>{stage.removeEventListener('wheel',wheel);stage.removeEventListener('gesturestart',start);stage.removeEventListener('gesturechange',change);stage.removeEventListener('gestureend',end);clearWheelGesture();pendingZoom.current=null;nativeGesture.current=null;};
    },[draft?.asset.assetId]);
    function error(e){setNotice('');c.setError(e?.code==='SOURCE_OVERLAP'||/overlaps already-owned source pixels/i.test(e?.message)?t('cutOverlap'):e);}
    async function act(fn){if(busyRef.current)return;busyRef.current=true;setBusy(true);setNotice('');try{await fn();}catch(e){if(alive.current)error(e);}finally{busyRef.current=false;if(alive.current)setBusy(false);}}
    function finishEditor(){settleFeedbackText(core,c,activeNote?.id);}
    function change(fn){try{finishEditor();const now=c.getSnapshot().draft;if(now)c.commit(fn(now));}catch(e){error(e);}}
    function focusEditor(){setFocusRequest(n=>n+1);}
    function chooseNote(id,focus=true){if(activeNote?.id!==id)finishEditor();const n=c.getSnapshot().draft?.annotations.find(n=>n.id===id);setSelected(n?.target.kind==='block'?n.target.blockId:null);setSelectedNote(n?.id||null);if(n&&focus)focusEditor();}
    function chooseBlock(id,focus=false){finishEditor();const now=c.getSnapshot().draft;setSelected(id);setSelectedNote(id?blockComment(now,id,null)?.id||null:null);if(id&&focus)focusEditor();}
    function addNote(target){
      try{finishEditor();const now=c.getSnapshot().draft;if(!now)return;const next=core.addAnnotation(now,{text:'',target}),id=next.annotations[next.annotations.length-1].id;
        c.beginTextEdit(target.kind==='block'?'block:'+target.blockId:'note:'+id);c.previewText(next);
        setSelected(target.kind==='block'?target.blockId:null);setSelectedNote(id);focusEditor();
      }catch(e){error(e);}
    }
    function editText(value){
      try{if(!editKey)return;c.beginTextEdit(editKey);const now=c.getSnapshot().draft;
        if(block){const result=writeBlockComment(core,now,block.id,value,activeNote?.id);c.previewText(result.draft);if(result.noteId!==selectedNote){setSelectedNote(result.noteId);focusEditor();}}
        else if(activeNote)c.previewText(core.updateAnnotation(now,activeNote.id,{text:value}));
      }catch(e){error(e);}
    }
    function setMode(value){try{finishEditor();setTool(value);}catch(e){error(e);}}
    function checkSession(){if(ctx.sidebarRight.mounted.getSnapshot()!==props.sessionId)throw new Error(t('sessionChanged'));}
    async function importSource(source){
      const result=await rpc(props.sessionId,source.kind==='stored'?{action:'read',assetId:source.assetId}:{action:'import',source});
      if(!alive.current)return;await c.useAsset(result.asset);setZoom(null);setSelected(null);setSelectedNote(null);setLibrary(null);setTool('select');setNotice('');
    }
    function requestImport(source){finishEditor();const now=c.getSnapshot().draft;if(now&&(now.blocks.length||now.annotations.length)){setConfirmation({kind:'switch',run:()=>act(()=>importSource(source))});return;}act(()=>importSource(source));}
    async function fromFile(file){if(!file)return;if(!/^image\/(png|jpeg|webp|gif)$/.test(file.type))throw new Error(t('unsupported'));if(file.size>20*1024*1024)throw new Error('Image exceeds 20 MiB');const data=await readFile(file);requestImport({kind:'base64',data,mediaType:file.type,name:file.name||'clipboard.png'});}
    function sourceOf(text){text=text.trim();if(/^data:image\/(?:png|jpeg|webp|gif);base64,/i.test(text)||(/^[A-Za-z0-9+/\r\n]+=*$/.test(text)&&text.length>100))return {kind:'base64',data:text};if(/^(?:[A-Za-z]:[\\/]|\\\\|\/|\.\.?[\\/])/.test(text))return {kind:'path',path:text.replace(/^"|"$/g,'')};throw new Error(t('invalidPaste'));}
    function paste(event){if(event.target.closest('textarea,input,[contenteditable=true]')||isLocked)return;const file=[...event.clipboardData.files].find(f=>f.type.startsWith('image/'));if(file){event.preventDefault();fromFile(file).catch(error);return;}const text=event.clipboardData.getData('text/plain');if(text){event.preventDefault();try{requestImport(sourceOf(text));}catch(e){error(e);}}}
    function openLibrary(){if(menuRef.current)menuRef.current.open=false;act(async()=>setLibrary(await rpc(props.sessionId,{action:'list',limit:30})));}
    function point(event){const r=svgRef.current.getBoundingClientRect();return {x:Math.max(0,Math.min(draft.asset.width,(event.clientX-r.left)/r.width*draft.asset.width)),y:Math.max(0,Math.min(draft.asset.height,(event.clientY-r.top)/r.height*draft.asset.height))};}
    function updateSmartHover(event){
      if(!draft||!smartEnabled||tool!=='select'||isLocked||space.current||event.shiftKey||event.pointerType==='touch'||event.buttons||event.target.closest('[data-note-id],[data-block-id]')){clearSmartHover();return;}
      const p=point(event);hoverPoint.current=p;
      const candidate=smartHoverCandidate(core,smartEngine,draft,smartIndex,p,hoverCandidate.current);
      if(candidate?.id===hoverCandidate.current?.id)return;
      hoverCandidate.current=candidate;setSmartHover(candidate?{assetId:draft.asset.assetId,candidate}:null);
    }
    function down(event){
      if(!draft||isLocked||pointer.current||![0,1].includes(event.button))return;
      event.preventDefault();
      if(event.button===1||space.current||tool==='pan'){
        finishEditor();stageRef.current?.focus({preventScroll:true});
        pointer.current={pointerId:event.pointerId,owner:c,sessionId:props.sessionId,history:c.getSnapshot().history,kind:'pan',assetId:draft.asset.assetId,x:event.clientX,y:event.clientY,left:stageRef.current.scrollLeft,top:stageRef.current.scrollTop};setPanning(true);event.currentTarget.setPointerCapture(event.pointerId);return;
      }
      const p=point(event),noteId=event.target.closest('[data-note-id]')?.getAttribute('data-note-id');
      const markerHit=!!event.target.closest('[data-note-marker]'),now=c.getSnapshot().draft;
      const visibleBlock=core.hitTest(now,p),blockId=event.target.closest('[data-block-id]')?.getAttribute('data-block-id')||(!markerHit?visibleBlock?.id:null);
      const note=now.annotations.find(n=>n.id===noteId);
      // Inactive transparent notes must not intercept a block; an explicitly selected frame keeps its drag intent.
      const routedNoteId=blockId&&!markerHit&&note?.target.kind==='region'&&activeNote?.id!==noteId?null:noteId;
      const intent=selectionIntent({tool,blockId,noteId:routedNoteId,noteKind:note?.target.kind,noteLocalKind:note?.target.local?.kind,forceNew:event.shiftKey});
      const candidate=intent==='draw-region'&&smartEnabled&&!event.shiftKey&&event.pointerType!=='touch'?smartHoverCandidate(core,smartEngine,now,smartIndex,p,hoverCandidate.current):null;
      clearSmartHover();
      if(intent==='edit-note'){chooseNote(noteId);return;}
      if(intent==='move-point'){
        if(activeNote?.id!==noteId)finishEditor();
        const current=c.getSnapshot().draft.annotations.find(n=>n.id===noteId);if(!current)return;
        setSelected(current.target.kind==='block'?current.target.blockId:null);setSelectedNote(noteId);
        pointer.current={pointerId:event.pointerId,owner:c,sessionId:props.sessionId,history:c.getSnapshot().history,kind:'point-move',noteId,start:p,origin:targetPoint(c.getSnapshot().draft,current),version:c.getSnapshot().history.version,assetId:draft.asset.assetId};
        event.currentTarget.setPointerCapture(event.pointerId);return;
      }
      if(intent==='move-region'){
        // A newly framed empty note remains pending until we know whether this is a click or a move.
        if(activeNote?.id!==noteId)finishEditor();
        const current=c.getSnapshot().draft.annotations.find(n=>n.id===noteId);if(!current)return;
        const r=current.target.rect;setSelected(null);setSelectedNote(noteId);
        pointer.current={pointerId:event.pointerId,owner:c,sessionId:props.sessionId,history:c.getSnapshot().history,kind:'region-move',noteId,start:p,origin:{x:r.x,y:r.y},width:r.width,height:r.height,version:c.getSnapshot().history.version,assetId:draft.asset.assetId};
        event.currentTarget.setPointerCapture(event.pointerId);return;
      }
      finishEditor();stageRef.current?.focus({preventScroll:true});
      if(intent==='point'){
        const b=draft.blocks.find(b=>b.id===blockId);
        addNote(b?{kind:'block',blockId,local:{kind:'point',point:{x:Math.min(b.source.width-1,Math.max(0,p.x-b.destination.x)),y:Math.min(b.source.height-1,Math.max(0,p.y-b.destination.y))}}}:{kind:'point',space:'layout',point:{x:Math.min(draft.asset.width-1,p.x),y:Math.min(draft.asset.height-1,p.y)}});return;
      }
      if(intent==='move-block'){
        chooseBlock(blockId);const b=c.getSnapshot().draft.blocks.find(b=>b.id===blockId);
        pointer.current={pointerId:event.pointerId,owner:c,sessionId:props.sessionId,history:c.getSnapshot().history,kind:'move',id:blockId,start:p,origin:{x:b.destination.x,y:b.destination.y},width:b.source.width,height:b.source.height,version:c.getSnapshot().history.version,assetId:draft.asset.assetId};
      }else pointer.current={pointerId:event.pointerId,owner:c,sessionId:props.sessionId,history:c.getSnapshot().history,kind:intent,start:p,candidate,manual:false,version:c.getSnapshot().history.version,assetId:draft.asset.assetId};
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    function destination(a,p){return {x:Math.round(Math.max(0,Math.min(draft.asset.width-a.width,a.origin.x+p.x-a.start.x))),y:Math.round(Math.max(0,Math.min(draft.asset.height-a.height,a.origin.y+p.y-a.start.y)))};}
    function move(event){
      const a=pointer.current;if(!a){updateSmartHover(event);return;}
      if(a.pointerId!==event.pointerId)return;
      if(!selectionGestureCurrent(a,c,props.sessionId)){cancelPointer();return;}
      if(a.kind==='pan'){stageRef.current.scrollLeft=a.left-event.clientX+a.x;stageRef.current.scrollTop=a.top-event.clientY+a.y;return;}
      const p=point(event);
      if(a.kind==='move'){setTransient({kind:'move',id:a.id,point:destination(a,p)});return;}
      if(a.kind==='point-move'){
        if(Math.hypot(p.x-a.start.x,p.y-a.start.y)*scale<4){setTransient(null);return;}
        try{const preview=movePointAnnotation(core,c.getSnapshot().draft,a.noteId,{x:a.origin.x+p.x-a.start.x,y:a.origin.y+p.y-a.start.y}).draft;setTransient({kind:'point-move',draft:preview});}
        catch(e){cancelPointer();if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);error(e);}
        return;
      }
      if(a.kind==='region-move'){
        if(Math.hypot(p.x-a.start.x,p.y-a.start.y)*scale<4){setTransient(null);return;}
        try{
          if(!a.preview)a.preview=promoteRegion(core,c.getSnapshot().draft,a.noteId);
          const preview=core.moveBlock(a.preview.draft,a.preview.blockId,destination(a,p),{bounds:'clamp'});
          setTransient({kind:'region-move',draft:preview,blockId:a.preview.blockId});
        }catch(e){cancelPointer();if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);error(e);}
        return;
      }
      if(Math.hypot(p.x-a.start.x,p.y-a.start.y)*scale>=4)a.manual=true;
      setTransient({kind:a.kind,rect:{x:Math.min(a.start.x,p.x),y:Math.min(a.start.y,p.y),width:Math.abs(p.x-a.start.x),height:Math.abs(p.y-a.start.y)}});
    }
    function cancelPointer(event){
      const a=pointer.current;if(event?.pointerId!==undefined&&a?.pointerId!==event.pointerId)return;
      pointer.current=null;
      if(a&&svgRef.current?.hasPointerCapture(a.pointerId))svgRef.current.releasePointerCapture(a.pointerId);
      setTransient(null);setPanning(false);clearSmartHover();
    }
    function up(event){
      const a=pointer.current;if(!a||a.pointerId!==event.pointerId)return;cancelPointer();
      const now=c.getSnapshot();
      if(a.kind==='pan'||!now.draft||!now.history||!selectionGestureCurrent(a,c,props.sessionId))return;
      const p=point(event),dragged=Math.hypot(p.x-a.start.x,p.y-a.start.y)*scale>=4;
      if(a.kind==='point-move'){
        if(!dragged){chooseNote(a.noteId,true);return;}
        try{const result=commitPointMove(core,c,a.noteId,{x:a.origin.x+p.x-a.start.x,y:a.origin.y+p.y-a.start.y});const note=result.draft.annotations.find(n=>n.id===a.noteId);setSelected(note?.target.kind==='block'?note.target.blockId:null);setSelectedNote(a.noteId);focusEditor();}catch(e){error(e);}return;
      }
      if(a.kind==='region-move'){
        const d=destination(a,p);
        if(!dragged||(d.x===a.origin.x&&d.y===a.origin.y)){chooseNote(a.noteId,true);return;}
        try{const result=promoteSelectedRegion(core,c,a.noteId,d);setSelected(result.blockId);setSelectedNote(result.noteId);stageRef.current?.focus({preventScroll:true});}catch(e){error(e);}return;
      }
      if(a.kind==='move'){
        if(!dragged){chooseBlock(a.id,true);return;}
        change(d=>core.moveBlock(d,a.id,destination(a,p),{bounds:'clamp'}));return;
      }
      const rect=selectionGestureResult(a.start,p,scale,event.shiftKey?null:a.candidate,a.manual);if(!rect){setSelected(null);setSelectedNote(null);return;}
      addNote({kind:'region',space:'layout',rect});
    }
    function key(event){
      if(event.nativeEvent?.isComposing)return;
      if(event.key==='Shift')clearSmartHover();
      if(event.key==='Escape'&&pathOpen&&event.target.closest('.dif-import')){event.preventDefault();setPathOpen(false);stageRef.current?.focus({preventScroll:true});return;}
      if(event.target.closest('textarea,input,[contenteditable=true]'))return;
      // Keyboard history and movement obey the same submission lock as buttons.
      if(isLocked)return;
      if(event.code==='Space'&&!event.target.closest('button,summary,a,select')){space.current=true;clearSmartHover();event.preventDefault();return;}
      if(event.key==='Escape'){c.cancelTextEdit();cancelPointer();setConfirmation(null);setLibrary(null);setPathOpen(false);if(menuRef.current)menuRef.current.open=false;setSelected(null);setSelectedNote(null);return;}
      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'){event.preventDefault();event.shiftKey?c.redo():c.undo();return;}
      if(block&&stageRef.current?.contains(event.target)&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)){event.preventDefault();const n=event.shiftKey?10:1;change(d=>{const b=d.blocks.find(x=>x.id===selected);return core.moveBlock(d,selected,{x:b.destination.x+(event.key==='ArrowRight'?n:event.key==='ArrowLeft'?-n:0),y:b.destination.y+(event.key==='ArrowDown'?n:event.key==='ArrowUp'?-n:0)},{bounds:'clamp'});});}
    }
    function removeBlock(){if(!block)return;const id=block.id,run=()=>change(d=>{setSelected(null);setSelectedNote(null);return core.removeBlock(d,id,{annotationPolicy:'remove'});});if(draft.annotations.some(a=>a.target.kind==='block'&&a.target.blockId===id))setConfirmation({kind:'delete',run});else run();}
    function removeNote(){if(!activeNote)return;const id=activeNote.id;finishEditor();const now=c.getSnapshot().draft;if(now.annotations.some(n=>n.id===id))c.commit(core.removeAnnotation(now,id));setSelectedNote(null);}
    async function send(){
      finishEditor();checkSession();await c.flush();const captured=c.getSnapshot().draft;if(!captured||!core.hasFeedback(captured))return;
      const fingerprint='unified-v1\n'+core.serializeDraft(captured);let record=c.getSubmission();
      if(record?.fingerprint===fingerprint&&record.accepted){setNotice(t('sendAgain'));return;}
      if(record?.fingerprint!==fingerprint){record={fingerprint,clientTimeZone:Intl.DateTimeFormat().resolvedOptions().timeZone};c.setSubmission(record);}
      if(!record.referenceAssetId){const data=await renderReference(captured,c.getSnapshot().asset),ref=await rpc(props.sessionId,{action:'import',source:{kind:'base64',data,mediaType:'image/png',name:'image-feedback-layout-reference.png'}});record.referenceAssetId=ref.asset.assetId;c.setSubmission(record);}
      if(!record.requestId){const bytes=new TextEncoder().encode(fingerprint+'\n'+record.referenceAssetId+'\n'+record.clientTimeZone);record.requestId='feedback-'+Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');c.setSubmission(record);}
      checkSession();if(c.getSnapshot().draft!==captured)throw new Error(t('feedbackChanged'));
      const result=await rpc(props.sessionId,{action:'submit',draft:captured,requestId:record.requestId,referenceAssetId:record.referenceAssetId,clientTimeZone:record.clientTimeZone});
      if(result.accepted){record.accepted=true;c.setSubmission(record);if(alive.current)setNotice(t('accepted'));}
    }
    function fill(){finishEditor();checkSession();const captured=c.getSnapshot().draft;if(!captured)return;if(inputPhase==='claimed')throw new Error(t('commandDraft'));const s=props.inputActions.captureInsertion(),span={...s,start:s.end,end:s.end};if(!props.inputActions.insertText('\n'+core.buildFeedback(captured).text+'\n',span))throw new Error(t('fillFailed'));setNotice(t('inserted')+' '+t('fillTextOnly'));}
    function exportJSON(){finishEditor();const now=c.getSnapshot().draft;if(!now)return;const url=URL.createObjectURL(new Blob([core.serializeDraft(now)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='image-feedback.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),0);if(menuRef.current)menuRef.current.open=false;}
    function button(label,fn,{icon,iconOnly=false,disabled=false,className='',...extra}={}){return h('button',{type:'button',className:'dif-btn '+(iconOnly?'dif-icon-btn ':'')+className,onClick:fn,disabled:isLocked||disabled,title:t(label),'aria-label':t(label),...extra},icon&&glyph(icon),!iconOnly&&h('span',{className:'dif-tool-label'},t(label)));}
    const itemKind=item=>t(item?.kind==='global'?'global':item?.kind==='move'?'moveItem':'commentItem');
    const signed=n=>(n>=0?'+':'')+Math.round(n);
    const moveLabel=item=>item.move?`${signed(item.move.delta.x)}, ${signed(item.move.delta.y)} px`:'';
    function activateItem(item){
      if(item.annotationId)chooseNote(item.annotationId);else chooseBlock(item.blockId,true);
      const anchor=item.layout,stage=stageRef.current,svg=svgRef.current;if(!anchor||!stage||!svg)return;
      const p=anchor.kind==='point'?anchor.point:{x:anchor.rect.x+anchor.rect.width/2,y:anchor.rect.y+anchor.rect.height/2};
      const r=svg.getBoundingClientRect(),v=stage.getBoundingClientRect();
      stage.scrollLeft+=r.left+p.x*scale-(v.left+stage.clientLeft+stage.clientWidth/2);
      stage.scrollTop+=r.top+p.y*scale-(v.top+stage.clientTop+stage.clientHeight/2);
    }
    const thumbnail=item=>item.move&&h('svg',{className:'dif-item-thumb',viewBox:`${item.block.source.x} ${item.block.source.y} ${item.block.source.width} ${item.block.source.height}`,preserveAspectRatio:'xMidYMid slice','aria-hidden':true},h('image',{href:asset.url,width:draft.asset.width,height:draft.asset.height}));
    const drawSvg=()=>h('svg',{ref:svgRef,className:'dif-canvas',width:Math.max(1,draft.asset.width*scale),height:Math.max(1,draft.asset.height*scale),viewBox:`0 0 ${draft.asset.width} ${draft.asset.height}`,role:'img','aria-label':t('reference'),style:{cursor:panning?'grabbing':tool==='pan'?'grab':tool==='select'?'default':'crosshair'},onPointerDown:down,onPointerMove:move,onPointerUp:up,onPointerCancel:cancelPointer,onLostPointerCapture:cancelPointer,onPointerLeave:()=>{if(!pointer.current)clearSmartHover();}},
      h('defs',null,h('mask',{id:clipId,maskUnits:'userSpaceOnUse',x:0,y:0,width:draft.asset.width,height:draft.asset.height},h('rect',{width:draft.asset.width,height:draft.asset.height,fill:'white'}),...showDraft.blocks.map(b=>h('rect',{key:b.id,...b.source,fill:'black'})))),
      h('image',{href:asset.url,width:draft.asset.width,height:draft.asset.height,mask:`url(#${clipId})`,pointerEvents:'none'}),
      ...showDraft.blocks.filter(b=>b.destination.x!==b.source.x||b.destination.y!==b.source.y).map(b=>h('rect',{key:'hole'+b.id,...b.source,fill:'none',stroke:'var(--dsw-alias-border-l2)',strokeWidth:1/scale,strokeDasharray:`${4/scale} ${3/scale}`,pointerEvents:'none'})),
      ...[...showDraft.blocks].sort((a,b)=>a.zIndex-b.zIndex).map(b=>h('g',{key:b.id,'data-block-id':b.id,className:'dif-block'},
        h('svg',{x:b.destination.x,y:b.destination.y,width:b.source.width,height:b.source.height,viewBox:`${b.source.x} ${b.source.y} ${b.source.width} ${b.source.height}`,overflow:'hidden'},h('image',{href:asset.url,width:draft.asset.width,height:draft.asset.height})),
        h('rect',{...b.destination,fill:'transparent',stroke:b.id===displaySelected?'var(--dif-annotation)':'var(--dsw-alias-border-l2)',strokeWidth:(b.id===displaySelected?2:.75)/scale}),
        b.id===displaySelected&&[[0,0],[1,0],[0,1],[1,1]].map(([x,y],i)=>h('rect',{key:i,x:b.destination.x+x*b.destination.width-2.5/scale,y:b.destination.y+y*b.destination.height-2.5/scale,width:5/scale,height:5/scale,fill:'var(--dsw-alias-bg-base)',stroke:'var(--dif-annotation)',strokeWidth:1/scale,pointerEvents:'none'}))
      )),
             ...displayItems.map(item=>{const anchor=item.layout;if(!anchor)return null;const p=anchor.kind==='point'?anchor.point:anchor.rect,hot=activeItem?.key===item.key;const x=Math.max(marker,Math.min(draft.asset.width-marker,p.x)),y=Math.max(marker,Math.min(draft.asset.height-marker,p.y));return h('g',{key:item.key,'data-note-id':item.annotationId||undefined,'data-block-id':item.annotationId?undefined:item.blockId},
         anchor.kind==='region'&&h('rect',{...anchor.rect,fill:'transparent',pointerEvents:item.annotation?.target.kind==='region'?undefined:'none',style:{cursor:tool==='select'?'move':'crosshair'},stroke:'var(--dif-annotation)',strokeWidth:(hot?2:1.5)/scale,strokeDasharray:hot?undefined:[4/scale,3/scale].join(' ')}),
         h('circle',{'data-note-marker':item.annotationId?true:undefined,style:{cursor:anchor.kind==='point'?'grab':tool==='select'?'move':'pointer'},cx:x,cy:y,r:marker,fill:'var(--dif-annotation)',stroke:'var(--dsw-alias-bg-base)',strokeWidth:(hot?2:1)/scale}),
         h('text',{x,y,fill:'var(--dif-annotation-ink)',fontSize:marker*1.15,fontWeight:600,textAnchor:'middle',dominantBaseline:'central',pointerEvents:'none'},item.number));}),
smartGeometry&&h(smartGeometry.tag,{'data-smart-preview':true,'data-smart-kind':smartPreview.kind,...smartGeometry.attrs,className:'dif-smart-preview',fill:'color-mix(in srgb,var(--dif-annotation) 5%,transparent)',stroke:'var(--dif-annotation)',strokeWidth:1.5/scale,strokeDasharray:`${5/scale} ${3/scale}`,pointerEvents:'none','aria-hidden':true}),
 transient?.rect&&h('rect',{...transient.rect,fill:'color-mix(in srgb,var(--dif-annotation) 8%,transparent)',stroke:'var(--dif-annotation)',strokeWidth:2/scale,pointerEvents:'none'})
    );
    const menu=()=>h('details',{className:'dif-menu',ref:menuRef},h('summary',{className:'dif-btn dif-icon-btn',title:t('options'),'aria-label':t('options')},glyph('more')),h('div',{className:'dif-menu-body'},
      button('openFile',()=>{menuRef.current.open=false;fileRef.current.click();},{icon:'image',disabled:!state.ready}),button('library',openLibrary,{icon:'image',disabled:!state.ready}),button('path',()=>{setPathOpen(x=>!x);menuRef.current.open=false;},{disabled:!state.ready}),
      draft&&button('smartSelection',()=>{clearSmartHover();setSmartEnabled(value=>!value);},{icon:smartEnabled?'check':undefined,'aria-pressed':smartEnabled,title:t('smartHint')}),
      draft&&button('export',exportJSON,{icon:'download'}),block&&button('removeBlock',()=>{menuRef.current.open=false;removeBlock();},{icon:'trash'}),draft&&h('p',{className:'dif-subtle'},t('keyboardHint'))));
    const inspector=(activeNote||block)&&h('div',{className:'dif-inspector','data-testid':'active-feedback'},
      h('div',{className:'dif-note-head'},h('span',{className:'dif-number'},activeItem?.number||'—'),h('span',{className:'dif-kind'},itemKind(activeItem)),h('span',{className:'dif-subtle'},block?`${block.destination.x-block.source.x>=0?'+':''}${block.destination.x-block.source.x}, ${block.destination.y-block.source.y>=0?'+':''}${block.destination.y-block.source.y} px`:''),h('span',{className:'dif-spacer'}),block&&button('reset',()=>change(d=>core.resetBlock(d,block.id)),{icon:'reset',iconOnly:true}),button(activeNote?'delete':'removeBlock',activeNote?removeNote:removeBlock,{icon:'trash',iconOnly:true})),
      h('textarea',{ref:editorRef,value:activeNote?.text||'',placeholder:t(block?'blockPlaceholder':'placeholder'),rows:2,maxLength:10000,'aria-label':t('notes'),disabled:isLocked,onFocus:()=>{if(editKey)c.beginTextEdit(editKey);},onChange:e=>editText(e.target.value),onBlur:e=>{if(e.relatedTarget?.getAttribute?.('data-feedback-action')!=='undo'&&!['region-move','point-move'].includes(pointer.current?.kind))finishEditor();},onKeyDown:e=>{
        if(e.nativeEvent.isComposing)return;
        if(e.key==='Escape'){e.preventDefault();e.stopPropagation();cancelPointer();c.cancelTextEdit();editorRef.current?.blur();}
        else if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){e.preventDefault();finishEditor();editorRef.current?.blur();stageRef.current?.focus({preventScroll:true});}
      }}),block&&!activeNote?.text&&h('div',{className:'dif-note-help'},t('optionalComment')));
    return h('section',{ref:rootRef,className:'dif-root','data-image-feedback-ui':'3.1','data-compact-height':compactHeight,'data-image-feedback-state':draft?'editing':'empty','aria-label':t('workspace'),onPaste:paste,onKeyDown:key,onKeyUp:e=>{if(e.code==='Space')space.current=false;},onBlur:e=>{if(!e.currentTarget.contains(e.relatedTarget))space.current=false;},onDragEnter:e=>{if(!isLocked&&e.dataTransfer.types.includes('Files')){e.preventDefault();dragDepth.current++;setFileHover(true);}},onDragLeave:()=>{dragDepth.current=Math.max(0,dragDepth.current-1);if(!dragDepth.current)setFileHover(false);},onDragOver:e=>{if(e.dataTransfer.types.includes('Files')){e.preventDefault();e.dataTransfer.dropEffect=isLocked?'none':'copy';}},onDrop:e=>{dragDepth.current=0;setFileHover(false);if(e.dataTransfer.types.includes('Files'))e.preventDefault();if(isLocked)return;const file=[...e.dataTransfer.files].find(f=>f.type.startsWith('image/'));if(file)fromFile(file).catch(error);}},
       fileHover&&h('div',{className:'dif-drop-target',role:'status'},glyph('image'),h('span',null,t('dropImage'))),
      h('style',null,CSS),h('input',{ref:fileRef,type:'file',accept:'image/png,image/jpeg,image/webp,image/gif',hidden:true,onChange:e=>{fromFile(e.target.files?.[0]).catch(error);e.target.value='';}}),
      draft&&h('header',{className:'dif-source'},glyph('image'),h('div',{className:'dif-source-info'},h('span',{className:'dif-source-name',title:asset.name||t('reference')},asset.name||t('reference')),h('span',{className:'dif-dimensions'},`${draft.asset.width} × ${draft.asset.height} px`)),h('span',{className:'dif-save-state','data-state':state.status,role:'status',title:state.error||t(state.status in MESSAGES.en?state.status:'ready')},h('span',null,t(state.status in MESSAGES.en?state.status:'ready'))),button('replace',openLibrary,{className:'dif-text-action'}),menu()),
      draft&&h('div',{className:'dif-toolbar',role:'toolbar','aria-label':t('tools')},h('div',{className:'dif-toolgroup'},...['select','point'].map(k=>button(k,()=>setMode(k),{icon:k,'aria-pressed':tool===k,title:t(k+'Help')}))),h('span',{className:'dif-spacer'}),h('i',{className:'dif-divider'}),button('undo',()=>c.undo(),{icon:'undo',iconOnly:true,'data-feedback-action':'undo',onPointerDown:e=>e.preventDefault(),disabled:!state.history.canUndo&&!c.getTextEditKey()}),button('redo',()=>{finishEditor();c.redo();},{icon:'redo',iconOnly:true,disabled:!state.history.canRedo})),
      pathOpen&&h('div',{className:'dif-import'},h('input',{type:'text',value:pathValue,placeholder:t('path'),'aria-label':t('path'),onChange:e=>setPathValue(e.target.value)}),button('import',()=>{try{requestImport(sourceOf(pathValue));setPathOpen(false);setPathValue('');}catch(e){error(e);}},{disabled:!state.ready}),button('cancel',()=>setPathOpen(false),{icon:'close',iconOnly:true})),
      library&&h('div',{className:'dif-library'},h('div',{className:'dif-library-head'},h('strong',null,t('library')),h('span',{className:'dif-spacer'}),button('openFile',()=>fileRef.current.click(),{icon:'image'}),button('cancel',()=>setLibrary(null),{icon:'close',iconOnly:true})),library.items.length?h('div',{className:'dif-asset-grid'},...library.items.map(a=>h('button',{key:a.assetId||a.attachmentId,type:'button',className:'dif-asset',disabled:isLocked,'aria-pressed':!!draft&&(a.assetId===draft.asset.assetId||a.attachmentId===draft.asset.attachmentId),onClick:()=>requestImport(a.assetId?{kind:'stored',assetId:a.assetId}:{kind:'history',attachmentId:a.attachmentId})},a.url?h('img',{src:a.url,alt:'',loading:'lazy'}):glyph('image'),h('span',null,a.name||t('reference')),h('small',null,`${a.width} × ${a.height}`)))):h('p',{className:'dif-subtle'},t('noImages')),library.nextOffset!=null&&button('more',()=>act(async()=>{const next=await rpc(props.sessionId,{action:'list',offset:library.nextOffset,limit:30});setLibrary({...next,items:[...library.items,...next.items]});}))),
      confirmation&&h('div',{ref:confirmationRef,className:'dif-inline-confirm',role:'alert',tabIndex:-1},h('span',null,t(confirmation.kind==='switch'?'newImageConfirm':confirmation.kind==='reload'?'reloadConfirm':'deleteConfirm')),button(confirmation.kind==='switch'?'switch':'confirm',()=>{const fn=confirmation.run;setConfirmation(null);fn();}),button('cancel',()=>setConfirmation(null))),
      h('div',{className:'dif-canvas-area'},h('div',{className:'dif-stage',ref:stageRef,tabIndex:0,onScroll:clearSmartHover,'aria-label':t('reference')},draft?h('div',{className:'dif-canvas-wrap'},drawSvg()):h('div',{className:'dif-empty'},emptyArtwork(),h('span',{className:'dif-eyebrow'},t('workspace')),h('strong',null,t('paste')),h('p',null,t('pasteHint')),h('div',{className:'dif-empty-actions'},button('openFile',()=>fileRef.current.click(),{icon:'image',className:'dif-primary',disabled:!state.ready}),button('library',openLibrary,{className:'dif-secondary',disabled:!state.ready})),button('path',()=>setPathOpen(x=>!x),{className:'dif-empty-more dif-text-action',disabled:!state.ready}),h('ol',{className:'dif-empty-steps','aria-label':t('workflow')},...['stepMark','stepMove','stepSend'].map((step,i)=>h('li',{key:step},h('span',{'aria-hidden':true},'0'+(i+1)),t(step)))))),
        draft&&h('div',{className:'dif-mode-hint'},t(tool==='point'?'pointHint':tool==='pan'?'panHint':!smartEnabled?'selectHint':smartScan?.status==='loading'?'smartPreparing':smartScan?.status==='unavailable'?'smartUnavailable':smartPreview?.kind==='paragraph'?'smartParagraph':smartPreview?.kind==='row'||smartPreview?.role==='row'?'smartRow':smartPreview?.shape==='ellipse'?'smartEllipse':smartPreview?.shape==='polygon'||smartPreview?.shape==='capsule'?'smartShape':smartPreview?'smartAdopt':'smartHint')),
        draft&&h('div',{className:'dif-zoom',title:t('zoomHint'),'aria-label':t('zoomHint')},button('pan',()=>setMode(tool==='pan'?'select':'pan'),{icon:'pan',iconOnly:true,'aria-pressed':tool==='pan'}),h('i',{className:'dif-divider'}),button('zoomOut',()=>zoomTo(scale/1.25),{icon:'minus',iconOnly:true}),h('span',null,Math.round(scale*100)+'%'),button('zoomIn',()=>zoomTo(scale*1.25),{icon:'plus',iconOnly:true}),button('fit',()=>{clearWheelGesture();pendingZoom.current=null;nativeGesture.current=null;setZoom(null);},{icon:'fit',iconOnly:true}))),
      draft&&h('div',{className:'dif-bottom'},h('div',{className:'dif-list-title'},h('strong',null,t('notes')),h('span',{className:'dif-count'},items.length),h('span',{className:'dif-spacer'}),button('addGlobal',()=>addNote({kind:'global'}),{icon:'plus',className:'dif-text-action'})),
                 h('div',{className:'dif-notes-scroll',ref:notesScrollRef},
           ...items.map(item=>h('div',{key:item.key,'data-review-key':item.key},activeItem?.key===item.key?inspector:h('button',{type:'button',className:'dif-note-row',onClick:()=>activateItem(item),disabled:isLocked,title:(item.text||itemKind(item))+(item.move?' · '+moveLabel(item):'')},h('span',{className:'dif-number'},item.number),thumbnail(item),h('span',{className:'dif-row-main'},h('span',{className:'dif-row-title'},h('span',{className:'dif-kind'},itemKind(item)),h('span',{className:'dif-note-snippet'},item.text||(item.move?t('moveOnly'):t('placeholder')))),item.move&&h('span',{className:'dif-row-meta'},moveLabel(item))),glyph('chevron')))),
           !activeItem&&block&&inspector,
           !items.length&&!block&&h('p',{className:'dif-empty-notes'},t('emptyNotes')))),
(state.error||notice)&&h('div',{className:'dif-status',role:state.error?'alert':'status','data-error':!!state.error},h('span',null,state.error||notice),state.error&&button('retrySave',()=>act(()=>c.flush())),state.error&&button('reload',()=>setConfirmation({kind:'reload',run:()=>act(()=>c.load({discard:true}))})),!state.error&&button('dismiss',()=>setNotice(''),{icon:'close',iconOnly:true})),
      draft&&h('footer',{className:'dif-footer'},h('div',{className:'dif-summary'},h('strong',null,`${items.length} ${t('itemCount')} · ${moves.length} ${t('changes')}`),h('span',null,t('sendIncludes'))),h('div',{className:'dif-footer-actions'},button('fill',()=>{try{fill();}catch(e){error(e);}},{className:'dif-secondary',title:t('fillTextOnly'),disabled:!core.hasFeedback(draft)}),button(state.sending?'sending':'send',()=>act(()=>c.runSubmission(send)),{icon:'send',className:'dif-primary',title:t('sendIncludes'),'aria-busy':state.sending,disabled:!state.ready||!core.hasFeedback(draft)})))
    );
  };
}
