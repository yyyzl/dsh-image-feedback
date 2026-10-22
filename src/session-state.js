/** Pure session state machine. Browser/Host details are injected; no React or DOM. */
export function createSessionState({sessionId,core,rpc,recovery,delay=400}) {
  let state={draft:null,asset:null,history:null,status:'loading',error:'',version:0,ready:false,sending:false};
  let saveTimer,queue=Promise.resolve(),disposed=false,lastSaved=null,epoch=0,loading=null,sendFlight=null,submission=null,textEdit=null,savingDraft=null;
  const subscribers=new Set();
  const same=(a,b)=>a&&b?core.serializeDraft(a)===core.serializeDraft(b):a===b;
  const publish=patch=>{if(disposed)return;state={...state,...patch};for(const fn of subscribers)fn();};
  // A cancelled preview still needs recovery if that preview's save is in flight.
  const isDirty=(draft=state.draft)=>Boolean(draft&&(draft!==lastSaved||(savingDraft&&draft!==savingDraft)));
  function previewValue(next) {
    const baseline=textEdit.baseline;
    const candidate=core.validateDraft(typeof next==='function'?next(state.draft):next,{sessionId,asset:baseline.asset});
    if(JSON.stringify(candidate.asset)!==JSON.stringify(baseline.asset))throw new core.CoreError('IDENTITY_MISMATCH','Text editing cannot replace the bound source asset.');
    const sources=new Map([...baseline.blocks,...state.draft.blocks].map(block=>[block.id,block.source]));
    for(const block of candidate.blocks){
      const source=sources.get(block.id);
      if(source&&['x','y','width','height'].some(key=>source[key]!==block.source[key]))throw new core.CoreError('IDENTITY_MISMATCH','Text editing cannot change an existing block source.');
    }
    return candidate;
  }
  function persist() {
    const dirty=isDirty();
    try{
      if(dirty||submission)recovery.write({schema:1,version:state.version,draft:dirty?state.draft:null,submission});
      else recovery.clear();
      return true;
    }catch(error){publish({error:'Local recovery unavailable: '+error.message});return false;}
  }
  const api={
    getSnapshot:()=>state,
    subscribe:fn=>{subscribers.add(fn);return()=>subscribers.delete(fn);},
    ensureLoaded(){return state.ready?Promise.resolve():loading??api.load();},
    getTextEditKey:()=>textEdit?.key??null,
    // Begin before staging a new annotation so creation and typing share one undo.
    beginTextEdit(key){
      if(disposed||!state.ready||!state.history)return state.draft;
      if(typeof key!=='string'||!key.trim())throw new TypeError('A text edit needs a nonempty string key.');
      if(textEdit?.key===key)return state.draft;
      api.finishTextEdit();
      textEdit={key,baseline:state.history.current};epoch++;
      if(state.status==='loading')publish({status:isDirty()?'unsaved':'saved'});
      return state.draft;
    },
    // Only the live draft advances here. Autosave must not close the undo group.
    previewText(next){
      if(disposed||!state.ready||!state.history)return state.draft;
      if(!textEdit)throw new Error('Begin a text edit before previewing text.');
      const draft=previewValue(next);
      if(draft===state.draft)return draft;
      epoch++;publish({draft,status:isDirty(draft)?'unsaved':'saved',error:''});persist();api.schedule();
      return draft;
    },
    finishTextEdit(){
      if(disposed||!textEdit)return state.draft;
      state.history.commit(state.draft);
      textEdit=null;epoch++;
      publish({draft:state.history.current,status:isDirty()?'unsaved':'saved',error:''});persist();
      if(isDirty())api.schedule();
      return state.draft;
    },
    cancelTextEdit(){
      if(disposed||!textEdit)return state.draft;
      const draft=textEdit.baseline;
      textEdit=null;epoch++;
      publish({draft,status:isDirty(draft)?'unsaved':'saved',error:''});persist();api.schedule();
      return draft;
    },
    load({discard=false}={}){
      if(disposed)return Promise.resolve();
      api.finishTextEdit();
      if(loading&&!discard)return loading;
      const started=++epoch;
      const task=(async()=>{
        if(state.ready&&!discard)await api.flush();
        if(disposed||started!==epoch)return;
        if(discard){clearTimeout(saveTimer);recovery.clear();submission=null;}
        publish({status:'loading',error:''});
        try{
          const result=await rpc({action:'loadDraft'});
          const remote=result.draft?core.validateDraft(result.draft,{sessionId}):null;
          let selected=remote,conflict=false,cached=null;
          try{cached=recovery.read();}catch{}
          if(cached?.schema===1){
            if(cached.submission)submission=cached.submission;
            if(cached.draft){
              const local=core.validateDraft(cached.draft,{sessionId});
              if(!same(local,remote)){selected=local;conflict=cached.version!==result.version;}
            }
          }
          const asset=selected?(await rpc({action:'read',assetId:selected.asset.assetId})).asset:null;
          if(disposed||started!==epoch)return;
          lastSaved=same(selected,remote)?selected:remote;
          publish({draft:selected,asset,history:selected?new core.History(selected,{limit:100}):null,version:conflict?cached.version:result.version,ready:true,
            status:conflict?'error':selected!==lastSaved?'unsaved':'saved',error:conflict?'A newer draft exists on the Host. Local recovery is retained. Export it or explicitly discard and reload before saving.':''});
          persist();if(selected!==lastSaved&&!conflict)api.schedule();
        }catch(error){if(!disposed&&started===epoch)publish({status:'error',error:error.message});}
      })().finally(()=>{if(loading===task)loading=null;});
      loading=task;return task;
    },
    commit(next){if(disposed||!state.ready||!state.history)return;api.finishTextEdit();state.history.commit(next);epoch++;publish({draft:state.history.current,status:'unsaved',error:''});persist();api.schedule();},
    undo(){if(disposed||!state.ready||!state.history)return;api.finishTextEdit();epoch++;state.history.undo();publish({draft:state.history.current,status:'unsaved',error:''});persist();api.schedule();},
    redo(){if(disposed||!state.ready||!state.history)return;api.finishTextEdit();epoch++;state.history.redo();publish({draft:state.history.current,status:'unsaved',error:''});persist();api.schedule();},
    schedule(){clearTimeout(saveTimer);if(!disposed)saveTimer=setTimeout(()=>{api.flush().catch(()=>{});},delay);},
    flush(){
      clearTimeout(saveTimer);
      queue=queue.catch(()=>{}).then(async()=>{
        const draft=state.draft;if(!draft||draft===lastSaved||disposed)return;
        savingDraft=draft;publish({status:'saving'});
        try{
          const result=await rpc({action:'saveDraft',draft,expectedVersion:state.version});
          if(disposed)return;
          lastSaved=draft;publish({version:result.version,status:state.draft===draft?'saved':'unsaved',error:''});persist();
        }catch(error){savingDraft=null;publish({status:'error',error:error.message});persist();throw error;}
        finally{savingDraft=null;}
      });return queue;
    },
    async useAsset(asset){
      await api.ensureLoaded();if(!state.ready)throw new Error('Load the saved state before importing a new image.');
      api.finishTextEdit();
      const beforeSave=epoch;
      await api.flush();
      if(disposed||beforeSave!==epoch)throw new Error('The current draft changed while saving. Its newer edits are retained; retry image selection.');
      const started=++epoch;
      const fields={assetId:asset.assetId,attachmentId:asset.attachmentId,width:asset.width,height:asset.height};
      const saved=await rpc({action:'loadDraft',assetId:asset.assetId});
      if(disposed||started!==epoch)throw new Error('The draft changed while selecting an image. Please retry.');
      const draft=saved.draft?core.validateDraft(saved.draft,{sessionId,asset:fields}):core.createDraft({sessionId,asset:fields});
      lastSaved=null;publish({asset,draft,history:new core.History(draft,{limit:100}),version:saved.version,status:'unsaved',error:''});persist();await api.flush();
    },
    getSubmission:()=>submission,
    setSubmission(value){submission=value;persist();},
    runSubmission(operation){
      if(sendFlight)return sendFlight;
      publish({sending:true});
      sendFlight=Promise.resolve().then(operation).finally(()=>{sendFlight=null;publish({sending:false});persist();});return sendFlight;
    },
    dispose(){if(disposed)return;api.finishTextEdit();persist();disposed=true;clearTimeout(saveTimer);subscribers.clear();},
    setError:error=>publish({error:String(error?.message||error),status:'error'})
  };
  return api;
}
