export const REVIEW_HTML = `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Comers · 待审阅</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f6f7f9;color:#242832;font:15px/1.6 system-ui,-apple-system,sans-serif}main{max-width:1080px;margin:36px auto;padding:0 24px}h1{font-size:28px;margin:0}header p{color:#68707c}button{border:1px solid #ccd2dc;border-radius:8px;padding:8px 13px;margin:4px 7px 4px 0;background:white;cursor:pointer}button.primary{background:#334ccc;color:white;border-color:#334ccc}button:disabled{opacity:.5;cursor:wait}article{padding:24px;margin:20px 0;background:white;border-radius:14px;border:1px solid #e2e5eb}h2{font-size:19px;margin:0 0 8px}h3{font-size:16px}.muted{color:#737b87;font-size:13px}.tag{padding:3px 8px;background:#f0f2fa;border-radius:6px;margin-right:7px}.artifact{margin-top:16px;padding-top:12px;border-top:1px solid #eee}textarea{width:100%;min-height:160px;border:1px solid #d7dce5;border-radius:8px;padding:12px;font:14px/1.6 system-ui}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f5f6f8;padding:14px;border-radius:8px}a{color:#334ccc}.error{color:#a43a36}#notice{position:sticky;top:0;background:#fff5df;border-radius:8px;padding:10px;display:none}.health{display:flex;flex-wrap:wrap;gap:12px}.tabs button.selected{background:#e8ecff;border-color:#99a8ef}details{margin:12px 0}
</style>
<main><header><h1>Comers · 待审阅</h1><p>AI 先处理，你决定下一步。消息回复、缺陷说明和代码分别审阅。</p><div class="health" id="health"></div></header><p id="notice"></p><p class="tabs" id="tabs"></p><section id="items"></section></main>
<script>
const token=location.hash.slice(1)||sessionStorage.getItem('comers-inbox-token')||'';sessionStorage.setItem('comers-inbox-token',token);history.replaceState(null,'',location.pathname);let state,filter='review';
const labels={review:'待审阅',queued:'待处理',running:'处理中',failed:'失败',interrupted:'已中断',ignored:'已忽略',pending:'待审阅',approved:'已通过',rejected:'已退回',sending:'正在发布',sent:'已发布',send_unknown:'结果待核实',reply:'建议回复',defect_handoff:'缺陷流转说明',code:'代码 / MR 草稿',analysis:'分析结果',clarification:'建议追问',p2p:'私聊',mention:'群聊 @',defect:'Meegle 缺陷'};
function el(tag,content,cls){const e=document.createElement(tag);if(content!==undefined)e.textContent=content;if(cls)e.className=cls;return e}
function link(parent,label,url){if(!/^https?:\\/\\//i.test(url))return;const a=el('a',label);a.href=url;a.target='_blank';a.rel='noopener noreferrer';parent.append(a,el('span',' '))}
function notice(msg){const e=document.getElementById('notice');e.textContent=msg;e.style.display='block'}
async function api(path,body){const r=await fetch('/api/'+path,{method:body?'POST':'GET',headers:{'X-Inbox-Token':token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const d=await r.json();if(!r.ok)throw Error(d.error||'访问失败');return d}
async function refresh(){state=await api('state');render()}
function button(parent,label,fn,primary=false){const b=el('button',label,primary?'primary':'');b.onclick=async()=>{b.disabled=true;try{await fn();await refresh()}catch(e){notice(e.message)}finally{b.disabled=false}};parent.append(b)}
function render(){
 const health=document.getElementById('health');health.replaceChildren();for(const source of ['p2p','mention','defect']){const h=state.health[source];health.append(el('span',labels[source]+' · '+(h?.error|| (h?'已检查 '+new Date(h.checkedAt).toLocaleTimeString('zh-CN'):'尚未检查')),h?.error?'error muted':'muted'))}
 const tabs=document.getElementById('tabs');tabs.replaceChildren();for(const s of ['review','queued','running','failed','interrupted','ignored']){const count=state.items.filter(i=>!i.mergedInto&&i.status===s).length;button(tabs,labels[s]+' '+count,async()=>{filter=s},filter===s)}
 const root=document.getElementById('items');root.replaceChildren();const items=state.items.filter(i=>!i.mergedInto&&i.status===filter).sort((a,b)=>b.updatedAt-a.updatedAt);if(!items.length)root.append(el('p','当前没有'+labels[filter]+'的事项','muted'));
 for(const item of items){const card=el('article');card.append(el('h2',item.title));const meta=el('p',labels[item.status]+' · '+new Date(item.updatedAt).toLocaleString('zh-CN'),'muted');for(const e of item.events){if(e.url)link(meta,labels[e.source]+'原文',e.url)}card.append(meta);if(item.sourceSessionId)card.append(el('p','已引用关联会话上下文，处理结果来自新会话','muted'));if(item.error)card.append(el('p',item.error,'error'));
 if(item.executionSessionId){const a=el('a','打开执行会话');a.href='codex://threads/'+encodeURIComponent(item.executionSessionId);card.append(a)}
 if(['failed','interrupted'].includes(item.status))button(card,'检查后重试',()=>api('retry',{itemId:item.id,revision:item.revision}));
 const sources=el('details');sources.append(el('summary','来源资料（'+item.events.length+'）'));for(const e of item.events)sources.append(el('pre',e.text));card.append(sources);
 for(const artifact of item.artifacts){const box=el('div',undefined,'artifact');box.append(el('h3',artifact.title),el('p',(labels[artifact.kind]||artifact.kind)+' · '+labels[artifact.status],'muted'));if(artifact.url)link(box,'查看链接',artifact.url);const body=el('textarea');body.value=artifact.body;body.readOnly=!['pending','approved','rejected'].includes(artifact.status);box.append(body);const input={itemId:item.id,artifactId:artifact.id,revision:item.revision};
 if(['pending','approved','rejected'].includes(artifact.status)){button(box,'保存修改',()=>api('edit',{...input,body:body.value}));button(box,'审阅通过',async()=>{if(body.value!==artifact.body)throw Error('请先保存修改再通过');await api('approve',input)},true);button(box,'退回',()=>api('reject',input))}
 if(artifact.kind==='code'&&item.worktree)button(box,'查看代码差异',async()=>{const d=await api('code?itemId='+encodeURIComponent(item.id));const pre=el('pre',d.diff||'没有未提交的代码差异');box.append(pre)});
 if(artifact.status==='approved'&&['reply','defect_handoff'].includes(artifact.kind))button(box,artifact.kind==='reply'?'发送这条回复':'发布缺陷说明',()=>api('send',input),true);
 if(artifact.status==='approved'&&artifact.kind==='code'&&item.worktree)button(box,'创建草稿 MR',()=>api('publish-mr',input),true);
 if(artifact.receipt){if(/^https:\\/\\//.test(artifact.receipt))link(box,'查看已发布 MR',artifact.receipt);else box.append(el('p',artifact.status==='sent'?'已发布':artifact.receipt,'muted'))}
 card.append(box)}root.append(card)}
}
refresh().catch(e=>notice(e.message));setInterval(()=>{if(document.activeElement?.tagName==='TEXTAREA')return;refresh().catch(e=>notice(e.message))},5000);
</script></html>`;
