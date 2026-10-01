// Presentation view for recordings: one phone per party, the obligation's journey through its
// states, and the audit trail, with a caption banner set by the tester (POST /mock/caption).
export function demoHtml() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TenLy live demo</title>
<style>
:root{--bg:#f4f2ec;--card:#fff;--ink:#1c1b19;--mute:#6f6d66;--line:#e2dfd6;--acc:#0f6e5a;--accs:#e3f1ec;--warn:#a5481b;--me:#dcf8c6;--them:#fff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.4 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
.cap{background:var(--acc);color:#fff;padding:14px 22px}.cap b{font-size:20px;display:block}.cap span{opacity:.9;font-size:14px}
.brand{float:right;font-weight:700;opacity:.85}
.journey{display:flex;gap:6px;padding:12px 22px;flex-wrap:wrap;align-items:center}
.st{padding:5px 11px;border-radius:99px;background:#e9e6de;color:var(--mute);font-size:12.5px;font-weight:600}
.st.done{background:var(--accs);color:var(--acc)}.st.now{background:var(--acc);color:#fff}
.meta{margin-left:auto;font-size:12.5px;color:var(--mute)}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;padding:0 22px 12px}
.phone{background:#ece5dd;border-radius:14px;border:1px solid var(--line);display:flex;flex-direction:column;height:430px;overflow:hidden}
.ph{background:#075e54;color:#fff;padding:9px 12px;font-weight:600;font-size:13.5px}.ph small{display:block;font-weight:400;opacity:.8;font-size:11.5px}
.msgs{flex:1;overflow:auto;padding:10px;display:flex;flex-direction:column;gap:7px}
.b{max-width:88%;padding:7px 9px;border-radius:9px;font-size:12.8px;box-shadow:0 1px 0 rgba(0,0,0,.06);white-space:pre-wrap}
.in{background:var(--them);align-self:flex-start}.out{background:var(--me);align-self:flex-end}
.b small{display:block;color:var(--mute);font-size:10.5px;margin-top:3px}
.btns{display:flex;gap:5px;margin-top:6px;flex-wrap:wrap}.btns span{border:1px solid #9fc9bd;color:#0b6b57;border-radius:6px;padding:2px 7px;font-size:11.5px;background:#fff}
.low{display:grid;grid-template-columns:1.1fr 1fr;gap:12px;padding:0 22px 18px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px}
.card h3{margin:0 0 8px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--mute)}
.kv{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:13px}.kv b{color:var(--mute);font-weight:600}
.feed{max-height:170px;overflow:auto;font-size:12.5px}.feed div{padding:4px 0;border-bottom:1px solid var(--line)}
.tag{display:inline-block;font-size:10.5px;font-weight:700;padding:1px 6px;border-radius:5px;background:#eef;color:#335;margin-right:5px}
.tag.agent{background:var(--accs);color:var(--acc)}.tag.guard{background:#fde9df;color:var(--warn)}
</style></head><body>
<div class="cap"><span class="brand">TenLy on AgenticOrg</span><b id="t">TenLy live demo</b><span id="s">Waiting for the first event…</span></div>
<div class="journey" id="j"></div>
<div class="grid">
 <div class="phone"><div class="ph">Priya <small>Tenant · Flat 302</small></div><div class="msgs" id="p-tenant"></div></div>
 <div class="phone"><div class="ph">Mr Sharma <small>Owner</small></div><div class="msgs" id="p-owner"></div></div>
 <div class="phone"><div class="ph">Raju <small>Plumber</small></div><div class="msgs" id="p-tradesman"></div></div>
</div>
<div class="low"><div class="card"><h3>Shared record · obligation</h3><div class="kv" id="ob"><b>Status</b><span>No obligation yet</span></div></div>
<div class="card"><h3>Audit trail (agent, guardrails, relay)</h3><div class="feed" id="au"></div></div></div>
<script>
let K='';try{K=sessionStorage.getItem('tk')||''}catch(e){}
const esc=s=>String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const get=p=>fetch(p,{headers:{'x-admin-key':K}}).then(r=>r.json());
const ST=['RECORDED','NOTIFIED','IN_PROGRESS','PROOF_CHECK','CLOSED'];
const rupee=p=>p?('₹'+(Number(p)/100).toLocaleString('en-IN')):'';
async function load(){ if(!K) return;
 const [L,wa,cap,lg]=await Promise.all([get('/mock/ledger'),get('/mock/outbox?n=80'),get('/mock/caption'),get('/mock/log?n=80')]);
 if(cap&&cap.title){t.textContent=cap.title;s.textContent=cap.sub||''}
 const role=Object.fromEntries(L.Parties.map(p=>[p.msisdn,p.role]));
 const box={tenant:[],owner:[],tradesman:[]};
 for(const m of wa.slice().reverse()){const r=role[m.to];if(!box[r])continue;const body=m.text?.body||m.interactive?.body?.text||'';const bt=(m.interactive?.action?.buttons||[]).map(x=>'<span>'+esc(x.reply.title)+'</span>').join('');
  box[r].push({at:m.at,html:'<div class="b in">'+esc(body)+(bt?'<div class="btns">'+bt+'</div>':'')+'<small>TenLy · '+new Date(m.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})+'</small></div>'});}
 for(const e of L.Inbox){const r=e.from_role;if(!box[r])continue;const txt=e.message_type==='button'?'▸ '+e.text:e.message_type==='image'?'📷 Photo: '+e.text:e.text;
  box[r].push({at:Date.parse(e.received_at),html:'<div class="b out">'+esc(txt)+'<small>'+esc(e.received_at.slice(11,16))+'</small></div>'});}
 for(const r of Object.keys(box)){const el=document.getElementById('p-'+r);el.innerHTML=box[r].sort((a,b)=>a.at-b.at).map(x=>x.html).join('');el.scrollTop=el.scrollHeight;}
 const o=L.Obligations[L.Obligations.length-1];
 const cur=o?o.state:'';const side=['ESCALATED','DISPUTED'].includes(cur);
 j.innerHTML=ST.map((x,i)=>{const ci=ST.indexOf(cur);return '<span class="st '+(x===cur?'now':(ci>i||cur==='CLOSED'&&x!=='CLOSED'?'done':''))+'">'+x.replace('_',' ')+'</span>'}).join('<span style="color:#aaa">→</span>')+(side?'<span class="st now" style="background:#a5481b">'+cur+'</span>':'')+'<span class="meta">Demo clock '+esc((L.Config&&new Date().toLocaleTimeString())||'')+'</span>';
 ob.innerHTML=o?[['Obligation',o.obligation_id+' · '+o.title],['Owed by',o.owed_by+' (clause '+o.source_ref+')'],['State',o.state],['Quote',rupee(o.quote_paise)+(o.slot?' · '+o.slot:'')+(o.part?' · part: '+o.part:'')],['Waybill',o.waybill],['Proofs',(o.proof_tradesman_msg_id?'photo ✓ ':'')+(o.proof_tenant_msg_id?'tenant ✓':'')],['Payout UTR',o.utr]].filter(x=>x[1]).map(x=>'<b>'+x[0]+'</b><span>'+esc(x[1])+'</span>').join(''):'<b>Status</b><span>No obligation yet</span>';
 const ag=L.Audit.filter(a=>a.actor==='agent').map(a=>({at:a.ts_ist,h:'<span class="tag agent">AGENT</span>'+esc((a.rule?a.rule+': ':'')+a.decision)}));
 const gd=lg.filter(a=>a.actor==='guard'||/refused|blocked/.test(a.action)).map(a=>({at:a.ts_ist,h:'<span class="tag guard">GUARDRAIL</span>'+esc(a.action+' – '+String(a.result).slice(0,90))}));
 au.innerHTML=[...ag,...gd].sort((a,b)=>String(b.at).localeCompare(String(a.at))).map(x=>'<div>'+x.h+'</div>').join('')||'<div style="color:#888">Nothing yet</div>';
}
load();setInterval(load,2500);
</script></body></html>`;
}
