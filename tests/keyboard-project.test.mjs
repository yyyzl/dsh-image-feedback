import test from 'node:test';
import assert from 'node:assert/strict';
import core from '../editor-core.js';
import {feedbackShortcut} from '../src/editor-intent.js';
import {createSessionState} from '../src/session-state.js';

const key=(key,extra={})=>({key,ctrlKey:true,...extra});
test('Windows 与 macOS 的批注撤销、重做和新建使用同一套快捷键规则',()=>{
  for(const modifiers of [{ctrlKey:true},{ctrlKey:false,metaKey:true}]){
    assert.equal(feedbackShortcut(key('z',modifiers),{editable:true,editingNote:true}),'undo');
    assert.equal(feedbackShortcut(key('Z',{...modifiers,shiftKey:true}),{editable:true,editingNote:true}),'redo');
    assert.equal(feedbackShortcut(key('n',modifiers),{editable:true,editingNote:true}),'new');
  }
  assert.equal(feedbackShortcut(key('y')),'redo');
  assert.equal(feedbackShortcut(key('z'),{editable:true}),null);
  assert.equal(feedbackShortcut(key('z',{altKey:true})),null);
  assert.equal(feedbackShortcut(key('z',{nativeEvent:{isComposing:true}})),null);
  assert.equal(feedbackShortcut(key('z',{defaultPrevented:true})),null);
});

async function setup(t){
  const asset={assetId:'synthetic-a',attachmentId:'sha256:'+'a'.repeat(64),width:200,height:100};
  let saved=core.createDraft({sessionId:'new-feedback',asset}),version=1,saveError=null,hold=null;
  const c=createSessionState({sessionId:'new-feedback',core,delay:600000,
    recovery:{read:()=>null,write:()=>{},clear:()=>{}},rpc:async request=>{
      if(request.action==='loadDraft')return {draft:saved,version};
      if(request.action==='read')return {asset:{...asset,url:'synthetic-test-only'}};
      if(request.action==='saveDraft'){
        if(hold)await hold;
        if(saveError)throw new Error(saveError);
        assert.equal(request.expectedVersion,version);saved=request.draft;return {version:++version};
      }
      throw new Error('Unexpected RPC');
    }});
  t.after(()=>c.dispose());await c.ensureLoaded();
  return {c,asset,saved:()=>saved,fail:message=>{saveError=message;},hold:promise=>{hold=promise;}};
}

test('新建前保存尚在输入的意见，随后可从同一张会话图片恢复',async t=>{
  const {c,asset,saved}=await setup(t);
  const staged=core.addAnnotation(c.getSnapshot().draft,{text:'尚在输入的意见',target:{kind:'global'}});
  c.beginTextEdit('note:'+staged.annotations[0].id);c.previewText(staged);
  await c.newProject();
  assert.equal(saved().annotations[0].text,'尚在输入的意见');
  assert.equal(c.getSnapshot().draft,null);assert.equal(c.getSnapshot().asset,null);assert.equal(c.getSnapshot().history,null);
  assert.equal(c.getTextEditKey(),null);
  await c.useAsset(asset);
  assert.equal(c.getSnapshot().draft.annotations[0].text,'尚在输入的意见');
});

test('新建保存失败时保留当前图片、意见和撤销历史',async t=>{
  const {c,fail}=await setup(t);
  c.commit(core.addAnnotation(c.getSnapshot().draft,{text:'保留意见',target:{kind:'global'}}));
  const before=c.getSnapshot();fail('模拟磁盘写入失败');
  await assert.rejects(c.newProject(),/模拟磁盘写入失败/);
  assert.equal(c.getSnapshot().draft,before.draft);assert.equal(c.getSnapshot().asset,before.asset);
  assert.equal(c.getSnapshot().history,before.history);assert.equal(c.getSnapshot().history.canUndo,true);
});

test('新建等待保存时若又产生编辑，应保留更新内容并拒绝清空',async t=>{
  const {c,hold}=await setup(t);
  c.commit(core.addAnnotation(c.getSnapshot().draft,{text:'第一条',target:{kind:'global'}}));
  let release;hold(new Promise(resolve=>{release=resolve;}));
  const pending=c.newProject();
  await new Promise(resolve=>setImmediate(resolve));
  c.commit(core.addAnnotation(c.getSnapshot().draft,{text:'更新意见',target:{kind:'global'}}));
  release();await assert.rejects(pending,/changed while saving/);
  assert.equal(c.getSnapshot().draft.annotations.length,2);
});

test('批注文字事务完成后一次撤销，重做恢复原意见',async t=>{
  const {c}=await setup(t);
  const staged=core.addAnnotation(c.getSnapshot().draft,{text:'撤销这次批注',target:{kind:'global'}});
  c.beginTextEdit('note:'+staged.annotations[0].id);c.previewText(staged);
  c[feedbackShortcut(key('z'),{editable:true,editingNote:true})]();
  assert.equal(c.getSnapshot().draft.annotations.length,0);
  c[feedbackShortcut(key('Z',{shiftKey:true}),{editable:true,editingNote:true})]();
  assert.equal(c.getSnapshot().draft.annotations[0].text,'撤销这次批注');
});

test('清空当前保留素材和编号进度，一次撤销恢复全部文字与图块移动',async t=>{
  const {c,saved}=await setup(t),asset=c.getSnapshot().asset;
  let draft=core.addBlock(c.getSnapshot().draft,{x:10,y:10,width:40,height:30});
  draft=core.moveBlock(draft,draft.blocks[0].id,{x:80,y:30});
  draft=core.addAnnotation(draft,{text:'恢复所有意见',target:{kind:'global'}});
  c.beginTextEdit('clear-test');c.previewText(draft);c.finishTextEdit();
  const before=c.getSnapshot().draft;
  c.commit(core.clearFeedback(before));
  assert.equal(c.getSnapshot().asset,asset);
  assert.deepEqual(c.getSnapshot().draft.asset,before.asset);
  assert.equal(c.getSnapshot().draft.nextAnnotationNumber,before.nextAnnotationNumber);
  assert.equal(c.getSnapshot().draft.blocks.length,0);assert.equal(c.getSnapshot().draft.annotations.length,0);
  c.undo();assert.equal(c.getSnapshot().draft,before);
  c.redo();await c.flush();
  assert.equal(saved().blocks.length,0);assert.equal(saved().annotations.length,0);
});

test('清空空白图片不增加撤销步骤，也不丢弃已有重做历史',async t=>{
  const {c}=await setup(t),empty=c.getSnapshot().draft;
  c.commit(core.clearFeedback(empty));
  assert.equal(c.getSnapshot().draft,empty);assert.equal(c.getSnapshot().history.canUndo,false);
  c.commit(core.addAnnotation(empty,{text:'可重做',target:{kind:'global'}}));c.undo();
  c.commit(core.clearFeedback(c.getSnapshot().draft));
  assert.equal(c.getSnapshot().history.canRedo,true);
  c.redo();assert.equal(c.getSnapshot().draft.annotations[0].text,'可重做');
});
