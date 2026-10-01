// Demo console for testers: live view of the shared record, WhatsApp traffic and the three audit
// writers, plus controls to play the parties that have no live WhatsApp in a run.
export function consoleHtml() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TenLy console</title>
<style>
:root{--bg:#f6f5f2;--card:#fff;--ink:#1d1d1b;--mute:#6b6a66;--line:#e4e2dc;--acc:#0f6e5a;--warn:#a5481b;--chip:#eef3f1}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1e1e1c;--ink:#efede7;--mute:#a09e97;--line:#33322f;--acc:#5cc3a6;--warn:#f0a070;--chip:#22302b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
header{display:flex;gap:12px;align-items:center;justify-content:space-between;padding:14px 20px;border-bottom:1px solid var(--line);flex-wrap:wrap}
h1{font-size:18px;margin:0}h1 span{color:var(--acc)}h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--mute);margin:0 0 10px}
main{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:14px;padding:16px 20px}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;min-width:0}
.wide{grid-column:1/-1}input,select,button{font:inherit;border-radius:7px;border:1px solid var(--line);background:var(--card);color:var(--ink);padding:6px 9px}
button{cursor:pointer;background:var(--acc);border-color:var(--acc);color:#fff}button.ghost{background:transparent;color:var(--ink);border-color:var(--line)}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:6px 0}
table{width:100%;border-collapse:collapse;font-size:12.5px}th,td{text-align:left;padding:5px 6px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--mute);font-weight:600}
.scroll{max-height:340px;overflow:auto}.chip{display:inline-block;padding:1px 7px;border-radius:99px;background:var(--chip);font-size:11.5px}
.live{color:var(--acc);font-weight:600}.sim{color:var(--mute)}.err{color:var(--warn)}
.msg{border-bottom:1px solid var(--line);padding:6px 0}.msg small{color:var(--mute)}
</style></head><body>
<header><h1>Ten<span>Ly</span> console</h1>
<div class="row"><input id="key" type="password" placeholder="admin key" size="16"><button onclick="saveKey()">Connect</button>
<button class="ghost" onclick="act('/mock/reset',{})">Reset demo</button><button class="ghost" onclick="act('/mock/clock',{advance_minutes:5})">Clock +5 min</button>
<span id="now" class="chip"></span></div></header>
<main>
<section><h2>Play a party</h2>
<div class="row"><select id="role"><option value="owner">Owner (Mr Sharma)</option><option value="tradesman">Tradesman (Raju)</option><option value="tenant">Tenant (Priya)</option></select>
<input id="ob" placeholder="obligation id" size="10"></div>
<div class="row"><input id="txt" placeholder="message text, e.g. 1200, 4pm today, part: tap cartridge" style="flex:1;min-width:200px"><button onclick="send('text')">Send text</button></div>
<div class="row"><button class="ghost" onclick="btn('ok','OK')">OK</button><button class="ghost" onclick="btn('cancel','Cancel')">Cancel</button><button class="ghost" onclick="btn('notmine','Not responsible')">Not responsible</button>
<button class="ghost" onclick="btn('approve','Approve')">Approve</button><button class="ghost" onclick="btn('decline','Decline')">Decline</button>
<button class="ghost" onclick="btn('fixed','Fixed')">Fixed</button><button class="ghost" onclick="btn('broken','Still broken')">Still broken</button><button class="ghost" onclick="send('image')">Photo: job done</button></div>
<div class="row"><select id="ep"></select><select id="sc"></select><button class="ghost" onclick="scn()">Inject failure</button></div>
<div id="out" class="sim"></div></section>
<section><h2>WhatsApp traffic</h2><div id="wa" class="scroll"></div></section>
<section class="wide"><h2>Obligations</h2><div id="obl" class="scroll"></div></section>
<section><h2>Inbox (events waiting for the agent)</h2><div id="inbox" class="scroll"></div></section>
<section><h2>Audit (relay, wrappers, agent)</h2><div id="audit" class="scroll"></div></section>
</main>
<script>
let KEY='';try{KEY=sessionStorage.getItem('tk')||''}catch(e){}
document.getElementById('key').value=KEY;
const ENDP=['dlv.pincode','dlv.create','dlv.pickup','dlv.track','dlv.cancel','p3p.balance','caps.payout','caps.payout_status','caps.stock','wa.send'];
const SCN=['timeout','http500','malformed','html_error','not_serviceable','no_pickup_slot','undelivered_ndr','insufficient_balance','mandate_inactive','payout_pending','out_of_stock','rate_limited'];
ep.innerHTML=ENDP.map(x=>'<option>'+x+'</option>').join('');sc.innerHTML=SCN.map(x=>'<option>'+x+'</option>').join('');
function saveKey(){KEY=key.value;try{sessionStorage.setItem('tk',KEY)}catch(e){}load()}
async function call(p,b){const r=await fetch(p,{method:b?'POST':'GET',headers:{'x-admin-key':KEY,'content-type':'application/json'},body:b?JSON.stringify(b):undefined});return r.json()}
async function act(p,b){out.textContent=JSON.stringify(await call(p,b)).slice(0,300);load()}
function send(type){act('/mock/inbound',{role:role.value,type,text:txt.value||(type==='image'?'done':'')})}
function btn(k,t){const o=document.getElementById('ob').value.trim();if(!o){out.textContent='Enter the obligation id first';return}act('/mock/inbound',{role:role.value,type:'button',button_id:k+':'+o,text:t})}
function scn(){act('/mock/scenario',{endpoint:ep.value,scenario:sc.value})}
const esc=s=>String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
function table(rows,cols){if(!rows.length)return '<p class="sim">Nothing yet.</p>';return '<table><tr>'+cols.map(c=>'<th>'+c+'</th>').join('')+'</tr>'+rows.map(r=>'<tr>'+cols.map(c=>'<td>'+esc(r[c])+'</td>').join('')+'</tr>').join('')+'</table>'}
async function load(){if(!KEY)return;try{
const h=await (await fetch('/health')).json();now.textContent='Demo time '+h.now_ist;
const L=await call('/mock/ledger');if(L.error){out.textContent=L.error;return}
obl.innerHTML=table(L.Obligations,['obligation_id','type','title','state','owed_by','due_at','quote_paise','slot','part','waybill','proof_tradesman_msg_id','proof_tenant_msg_id','utr','next_action_at','ladder_step']);
inbox.innerHTML=table(L.Inbox.slice(-15).reverse(),['event_id','from_role','message_type','text','button_id','processed']);
const wa=await call('/mock/outbox?n=40');const P=Object.fromEntries(L.Parties.map(p=>[p.msisdn,p.role+' '+p.name]));
document.getElementById('wa').innerHTML=wa.map(m=>{const body=m.text?.body||m.interactive?.body?.text||m.type;const b=(m.interactive?.action?.buttons||[]).map(x=>'['+x.reply.title+']').join(' ');
return '<div class="msg"><small>'+new Date(m.at).toLocaleTimeString()+' to '+esc(P[m.to]||m.to)+' <span class="'+(m.live?'live':'sim')+'">'+(m.live?'WhatsApp '+(m.http||''):'simulated')+'</span>'+(m.error?' <span class=err>'+esc(m.error)+'</span>':'')+'</small><div>'+esc(body)+' '+esc(b)+'</div></div>'}).join('')||'<p class="sim">No messages yet.</p>';
const lg=await call('/mock/log?n=60');audit.innerHTML=table(lg,['actor','action','rule','obligation_id','result']);
}catch(e){out.textContent=String(e)}}
load();setInterval(load,4000);
</script></body></html>`;
}
