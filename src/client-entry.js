window.__ModuleLoader__.load({
  id: '@yyyzl/dsh-image-feedback',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'localImageFeedback';
    // Stable native tab identity from the local edition; this is NOT the module owner ID.
    const ID = '@local/dsh-image-feedback';
    const KIND = 'local-image-feedback';
    const dictionaries = {
      zh: { title:'图片反馈', description:'拆块拖动 · 标记意见 · 发回当前会话', loading:'正在加载图片编辑器…', retry:'重试', unavailable:'编辑器加载失败', preparing:'图片反馈面板已接入，正在完成编辑功能。' },
      en: { title:'Image Feedback', description:'Move blocks · Annotate · Send to chat', loading:'Loading image editor…', retry:'Retry', unavailable:'Unable to load editor', preparing:'The image feedback panel is connected. Editing capabilities are being prepared.' }
    };
    function Icon() {
      return h('svg',{width:20,height:20,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.6,'aria-hidden':true},
        h('rect',{x:3,y:3,width:16,height:15,rx:3}),h('circle',{cx:8,cy:8,r:1.4}),h('path',{d:'m4 15 5-5 4 4 3-2 3 3 M15 16h6v5h-4l-2 2z',fill:'var(--dsw-alias-bg-base)'}));
    }
    return {
      inject:['slots','locale','sidebarRightTabs','sidebarRight','sessions'],
      apply(ctx) {
        ctx.effect(()=>ctx.locale.register(NS,dictionaries));
        const t=ctx.locale.bind(NS);
        let editorPromise, editorComponent;
        const load=()=>editorPromise??=(require.async('./client.editor.js').catch(error=>{editorPromise=undefined;throw error;}));
        function Launch(props) {
          return h('button',{type:'button',title:props.t('title'),'aria-label':props.t('title'),onClick:()=>{
            if(ctx.sidebarRight.mounted.getSnapshot()!==props.sessionId)return;
            ctx.sidebarRight.openTab(KIND);
          },style:{display:'inline-flex',alignItems:'center',gap:5,border:0,borderRadius:8,padding:'5px 8px',background:'transparent',color:'var(--dsw-alias-label-secondary)',cursor:'pointer',font:'inherit'}},h(Icon),h('span',{style:{fontSize:12}},props.t('title')));
        }
        function Body(props) {
          const {tab}=props.useTabInfo();
          const [Loaded,setLoaded]=React.useState(null);
          const [failure,setFailure]=React.useState('');
          const [retry,setRetry]=React.useState(0);
          React.useEffect(()=>{
            let active=true;
            load().then(module=>{if(active){editorComponent??=module.createEditor({React,ctx,NS,Icon});setLoaded(()=>editorComponent);}}).catch(error=>{if(active)setFailure(String(error.message||error));});
            return()=>{active=false;};
          },[retry]);
          if(!tab.visible)return null;
          if(Loaded)return h(Loaded,props);
          return h('div',{style:{padding:24,color:'var(--dsw-alias-label-secondary)',fontSize:13},'data-image-feedback-state':'loading'},
            failure?props.t('unavailable'):props.t('loading'),failure&&h('pre',{style:{whiteSpace:'pre-wrap'}},failure),failure&&h('button',{onClick:()=>{setFailure('');setRetry(x=>x+1);}},props.t('retry')));
        }
        ctx.effect(()=>ctx.sidebarRightTabs.register({
          id:ID,kind:KIND,title:()=>t('title'),
          guide:[{id:'image-feedback',title:()=>t('title'),description:()=>t('description'),icon:Icon,order:50}]
        }));
        // Hide only legacy internal storage-command rows; retain durable audit records.
        // Actual tool calls and submitted feedback remain visible.
        ctx.slots.inject('conversation.chat.commandview',()=>ctx.slots.register({name:'conversation.chat.commandview',key:'image-feedback'},()=>null));
        ctx.slots.inject('conversation.input.left',()=>ctx.slots.register({name:'conversation.input.left',id:'local-image-feedback-open',order:35,locale:NS},Launch));
        ctx.slots.inject('sidebar.right.pane.tab',()=>ctx.slots.register({name:'sidebar.right.pane.tab',key:ID,locale:NS},Body));
        ctx.slots.inject('sidebar.right.pane.tab.title',()=>ctx.slots.register({name:'sidebar.right.pane.tab.title',key:ID,locale:NS},props=>h('span',{style:{display:'inline-flex',alignItems:'center',gap:5}},h(Icon),props.t('title'))));
      }
    };
  }
});
