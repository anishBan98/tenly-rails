// Reference TenLy agent: a deterministic implementation of the system prompt's rules (R1-R21),
// talking to the rails ONLY through MCP over HTTP with the official SDK client, exactly as the
// AgenticOrg agent will. It is the test driver for the end-to-end runs, not the product: on the
// platform, the LLM agent makes these decisions from prompts/tenly_system_prompt_v1.txt.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const TRADES = [
  { trade: 'plumbing', re: /\b(nal|tap|leak|pipe|nali|drain|flush|toilet|paani)\b/i },
  { trade: 'electrical', re: /\b(geyser|bijli|switch|pankha|fan|light|socket|wiring|ac)\b/i },
];

export class RefAgent {
  constructor({ baseUrl, keys, plural, runPrefix = 'run' }) {
    this.baseUrl = baseUrl; this.keys = keys; this.plural = plural; this.runPrefix = runPrefix; this.runSeq = 0;
    this.clients = {};
  }

  async connect() {
    for (const [name, path] of Object.entries({ sheets: 'sheets', gnani: 'gnani', wa: 'wa-ui', dlv: 'delhivery', p3p: 'p3p', caps: 'caps' })) {
      const c = new Client({ name: `tenly-ref-${name}`, version: '1.0.0' });
      await c.connect(new StreamableHTTPClientTransport(new URL(`${this.baseUrl}/mcp/${path}`), { requestInit: { headers: { 'x-api-key': this.keys[name] } } }));
      this.clients[name] = c;
    }
  }

  async close() { for (const c of Object.values(this.clients)) await c.close(); }

  async call(server, name, args) {
    const r = await this.clients[server].callTool({ name, arguments: args });
    const data = r.structuredContent ?? JSON.parse(r.content?.[0]?.text || '{}');
    return { ok: !r.isError, data };
  }

  // ---------- helpers ----------
  async read(tab, where) { return (await this.call('sheets', 'read_range', { tab, where })).data; }
  async audit(ctx, row) {
    await this.call('sheets', 'append_rows', { tab: 'Audit', rows: [{ event_id: ctx.event.event_id, run_id: ctx.run_id, tenancy_id: ctx.tenancy.tenancy_id, prompt_version: 'v1', ...row }] });
    ctx.decisions.push(row);
  }
  async setState(ctx, ob, to, extra = {}) {
    const r = await this.call('sheets', 'update_range', { tab: 'Obligations', where: { obligation_id: ob.obligation_id }, set: { state: to, state_since: ctx.now, ...extra } });
    if (!r.ok) throw new Error(`state change refused: ${JSON.stringify(r.data)}`);
    const from = ob.state; Object.assign(ob, { state: to, ...extra });
    return from;
  }
  async patch(ob, set) {
    const r = await this.call('sheets', 'update_range', { tab: 'Obligations', where: { obligation_id: ob.obligation_id }, set });
    if (!r.ok) throw new Error(`update refused: ${JSON.stringify(r.data)}`);
    Object.assign(ob, set);
  }
  cfg(ctx, key) { const c = ctx.config.find((x) => x.key === key); return Number(ctx.demo ? c?.value_demo : c?.value_prod); }
  later(ctx, minutes) { return new Date(Date.parse(ctx.now) + minutes * 60000 + 5.5 * 3600e3).toISOString().replace(/\.\d{3}Z$/, '+05:30'); }
  party(ctx, role, trade) { return ctx.parties.find((p) => p.role === role && (!trade || p.trades.split(',').includes(trade))); }
  async text(ctx, to, body, rule, decision, ob) {
    const r = await this.call('wa', 'send_text_message', { to: to.msisdn, body });
    await this.audit(ctx, { obligation_id: ob?.obligation_id || '', decision, rule, action: 'send_text_message', to: `${to.role}:${to.name}`, message_text: body, via_connector: 'whatsapp', result: r.ok ? 'sent' : `failed: ${JSON.stringify(r.data).slice(0, 200)}`, external_ref: r.data.message_id || '' });
    return r;
  }
  async buttons(ctx, to, body, buttons, rule, decision, ob) {
    const r = await this.call('wa', 'send_interactive_message', { to: to.msisdn, body, buttons });
    await this.audit(ctx, { obligation_id: ob?.obligation_id || '', decision, rule, action: 'send_interactive_message', to: `${to.role}:${to.name}`, message_text: `${body} [${buttons.map((b) => b.title).join('] [')}]`, via_connector: 'tenly_wa_ui', result: r.ok ? 'sent' : 'failed', external_ref: r.data.message_id || '' });
    return r;
  }
  async voice(ctx, to, body, lang, ob) {
    const t = await this.call('gnani', 'tts', { text: body, language: lang });
    if (!t.ok) return;
    const r = await this.call('wa', 'send_media_message', { to: to.msisdn, type: 'audio', media_url: t.data.audio_url });
    await this.audit(ctx, { obligation_id: ob?.obligation_id || '', decision: 'voice reply', rule: 'R5', action: 'gnani tts + send_media_message', to: `${to.role}:${to.name}`, message_text: body, via_connector: 'tenly_gnani + whatsapp', result: r.ok ? 'sent' : 'failed', external_ref: t.data.sha256 || '' });
  }
  rupees(p) { return `₹${(Number(p) / 100).toLocaleString('en-IN')}`; }

  // ---------- entry points ----------
  async tick() {
    const runs = [];
    const inbox = (await this.read('Inbox', { processed: 'FALSE' })).rows;
    for (const ev of inbox) {
      const run_id = `${this.runPrefix}-${++this.runSeq}`;
      const out = await this.handle({ ...ev, event_type: 'message', demo_mode: true }, run_id);
      await this.call('sheets', 'update_range', { tab: 'Inbox', where: { event_id: ev.event_id }, set: { processed: 'TRUE', run_id } });
      runs.push(out);
    }
    runs.push(await this.sweep());
    return runs;
  }

  async context(event, run_id) {
    const tenancyId = event.tenancy_id || 'T-302';
    const t = await this.read('Tenancy', { tenancy_id: tenancyId });
    const now = t.now_ist;
    return {
      event, run_id, now, demo: true, decisions: [],
      tenancy: t.rows[0], parties: (await this.read('Parties', { tenancy_id: tenancyId })).rows,
      config: (await this.read('Config')).rows,
      obligations: (await this.read('Obligations', { tenancy_id: tenancyId })).rows,
      audit: (await this.read('Audit', { event_id: event.event_id })).rows,
    };
  }

  async handle(event, run_id) {
    const ctx = await this.context(event, run_id);
    const out = { event_id: event.event_id, run_id, decisions: ctx.decisions, needs_review: false };
    if (ctx.audit.some((a) => a.actor === 'agent')) return { ...out, skipped: 'duplicate' }; // G2
    if (ctx.tenancy.paused === 'TRUE' && event.text?.trim().toUpperCase() !== 'PAUSE') { await this.audit(ctx, { decision: 'skipped: paused', rule: 'R15' }); return out; }
    const who = ctx.parties.find((p) => p.msisdn === event.from_msisdn);
    const word = (event.text || '').trim().toUpperCase();
    if (['PAUSE', 'STOP', 'RESUME'].includes(word)) return this.pauseAck(ctx, who, word, out);
    if (event.message_type === 'button') return this.onButton(ctx, who, out);
    if (who.role === 'tenant') return this.onTenant(ctx, who, out);
    if (who.role === 'tradesman') return this.onTradesman(ctx, who, out);
    if (who.role === 'owner') return this.onOwner(ctx, who, out);
    return out;
  }

  async transcript(ctx, who) {
    if (ctx.event.message_type !== 'audio') return ctx.event.text || '';
    const r = await this.call('gnani', 'stt', { audio_url: ctx.event.media_url, language_code: who.language === 'hi' ? 'hi-IN' : 'en-IN', bias_list: ['nal', 'tap', 'geyser', 'leak', 'pipe', 'bijli', 'switch', 'pankha', 'AC', 'nali'] });
    const tx = (r.data.transcript || '').trim();
    await this.audit(ctx, { decision: tx ? 'transcribed voice note' : 'transcript empty', rule: 'R2', action: 'gnani stt', source_connector: 'tenly_gnani', source_ref: r.data.request_id || '', input_summary: tx.slice(0, 200), via_connector: 'tenly_gnani', result: r.ok ? 'ok' : 'error' });
    return r.ok ? tx : '';
  }

  // ---------- tenant ----------
  async onTenant(ctx, who, out) {
    const tx = await this.transcript(ctx, who);
    if (tx.split(/\s+/).filter(Boolean).length < 3) {
      await this.text(ctx, who, 'Maaf kijiye, main samajh nahi paaya. Kya aap dobara bol sakte hain ya likh kar bhej sakte hain?', 'R2', 'ask to re-record: transcript empty or unclear');
      return out;
    }
    const hit = TRADES.find((t) => t.re.test(tx));
    const clauses = JSON.parse(ctx.tenancy.clauses_json || '{}');
    const clauseId = hit && Object.keys(clauses).find((k) => clauses[k].toLowerCase().includes(hit.trade));
    const n = ctx.obligations.length + 1;
    const ob = {
      obligation_id: `OB-${String(n).padStart(2, '0')}`, tenancy_id: ctx.tenancy.tenancy_id, type: 'repair', title: tx.slice(0, 80),
      owed_by: clauseId ? 'owner' : 'undetermined', owed_to: 'tenant', source_type: clauseId ? 'clause' : 'transcript',
      source_ref: clauseId ? `clause ${clauseId}` : ctx.event.event_id, due_at: this.later(ctx, this.cfg(ctx, 'repair_due')),
      state: clauseId ? 'RECORDED' : 'DISPUTED', state_since: ctx.now, ladder_step: '0', notes: hit ? `trade=${hit.trade}` : 'trade=unknown',
    };
    await this.call('sheets', 'append_rows', { tab: 'Obligations', rows: [ob] });
    await this.audit(ctx, { obligation_id: ob.obligation_id, state_from: '', state_to: ob.state, decision: clauseId ? `recorded repair; clause ${clauseId} makes it the owner's` : 'no clause covers this fault', rule: 'R3', input_summary: tx, source_connector: 'whatsapp', source_ref: ctx.event.event_id, action: 'append obligation', via_connector: 'tenly_sheets' });
    if (!clauseId) { out.needs_review = true; out.review_reason = 'no clause covers the fault'; return out; }
    const owner = this.party(ctx, 'owner');
    const msgT = `Samajh gaya: "${tx}". Aapke agreement ka clause ${clauseId} kehta hai ki yeh ${owner.name} ki zimmedari hai. Maine unhe bata diya hai aur plumber se quote le raha hoon. Kal tak update dunga.`;
    await this.text(ctx, who, msgT, 'R4', 'acknowledge tenant with the clause', ob);
    if (ctx.event.message_type === 'audio') await this.voice(ctx, who, msgT, 'hi-IN', ob);
    const from = await this.setState(ctx, ob, 'NOTIFIED', { next_action_at: ob.due_at });
    await this.text(ctx, owner, `${ctx.tenancy.flat}: ${tx}. Clause ${clauseId} makes this yours. I am getting a quote from your approved ${hit.trade} tradesman and will book it if it is within your ${this.rupees(ctx.tenancy.per_job_limit_paise)} limit.`, 'R4', 'notify owner what, why, by when', ob);
    await this.audit(ctx, { obligation_id: ob.obligation_id, state_from: from, state_to: 'NOTIFIED', decision: 'owner notified', rule: 'R4' });
    const tm = this.party(ctx, 'tradesman', hit.trade);
    await this.patch(ob, { vendor_msisdn: tm.msisdn });
    await this.text(ctx, tm, `Naya kaam: ${tx} at ${ctx.tenancy.flat}, ${ctx.tenancy.address} (${ctx.tenancy.pincode}). Reply as: AMOUNT, TIME, part: PART-NAME or none`, 'R4', `ask ${hit.trade} tradesman for slot and quote`, ob);
    return out;
  }

  // ---------- tradesman ----------
  async onTradesman(ctx, who, out) {
    const mine = ctx.obligations.filter((o) => o.vendor_msisdn === who.msisdn);
    if (ctx.event.message_type === 'image' || /\b(done|ho gaya|fixed|complete)\b/i.test(ctx.event.text)) {
      const ob = mine.find((o) => o.state === 'IN_PROGRESS');
      if (!ob) return out;
      const from = await this.setState(ctx, ob, 'PROOF_CHECK', { proof_tradesman_msg_id: ctx.event.event_id });
      await this.audit(ctx, { obligation_id: ob.obligation_id, state_from: from, state_to: 'PROOF_CHECK', decision: 'tradesman proof recorded', rule: 'R11', source_connector: 'whatsapp', source_ref: ctx.event.event_id });
      await this.buttons(ctx, this.party(ctx, 'tenant'), `${who.name} says the job is done. Is it fixed?`, [{ id: `fixed:${ob.obligation_id}`, title: 'Fixed' }, { id: `broken:${ob.obligation_id}`, title: 'Still broken' }], 'R11', 'ask tenant to confirm the fix', ob);
      return out;
    }
    const m = /([\d,]+)\s*,\s*([^,]+?)\s*,\s*part:\s*(.+)$/i.exec(ctx.event.text || '');
    const ob = mine.find((o) => o.state === 'NOTIFIED' && !o.quote_paise);
    if (!ob) return out;
    if (!m) { await this.text(ctx, who, 'Please reply as: AMOUNT, TIME, part: PART-NAME or none', 'R4', 'quote unclear, ask again', ob); return out; }
    const quote = Number(m[1].replace(/,/g, '')) * 100;
    await this.patch(ob, { quote_paise: String(quote), slot: m[2], part: m[3].trim().toLowerCase() === 'none' ? '' : m[3].trim() });
    const spent = ctx.obligations.filter((o) => o.utr || o.payment_link_ref).reduce((s, o) => s + Number(o.amount_paise || 0), 0);
    const within = quote <= Number(ctx.tenancy.per_job_limit_paise) && spent + quote <= Number(ctx.tenancy.monthly_cap_paise);
    await this.audit(ctx, { obligation_id: ob.obligation_id, decision: within ? `quote ${this.rupees(quote)} within limits: book without asking` : `quote ${this.rupees(quote)} above limit: ask owner`, rule: within ? 'R7' : 'R8', input_summary: ctx.event.text, source_connector: 'whatsapp', source_ref: ctx.event.event_id });
    if (within) return this.book(ctx, ob, out);
    await this.patch(ob, { next_action_at: this.later(ctx, this.cfg(ctx, 'owner_reminder_after')), ladder_step: '0', notes: `${ob.notes};awaiting_approval` });
    await this.buttons(ctx, this.party(ctx, 'owner'), `${ob.title}: quote ${this.rupees(quote)} from ${who.name}, above your ${this.rupees(ctx.tenancy.per_job_limit_paise)} limit. Approve?`, [{ id: `approve:${ob.obligation_id}`, title: `Approve ${this.rupees(quote)}`.slice(0, 20) }, { id: `decline:${ob.obligation_id}`, title: 'Decline' }], 'R8', 'ask owner approval over limit', ob);
    return out;
  }

  async book(ctx, ob, out) {
    const tm = ctx.parties.find((p) => p.msisdn === ob.vendor_msisdn);
    const from = await this.setState(ctx, ob, 'IN_PROGRESS', { amount_paise: ob.quote_paise, next_action_at: this.later(ctx, this.cfg(ctx, 'proof_wait')) });
    await this.audit(ctx, { obligation_id: ob.obligation_id, state_from: from, state_to: 'IN_PROGRESS', decision: `booked ${tm.name} ${ob.slot}`, rule: ob.notes.includes('awaiting_approval') ? 'R10' : 'R7' });
    await this.text(ctx, tm, `Booked: ${ob.title} at ${ctx.tenancy.flat}, ${ob.slot}, ${this.rupees(ob.quote_paise)}. You are paid after the tenant confirms the fix.`, 'R7', 'confirm booking to tradesman', ob);
    await this.text(ctx, this.party(ctx, 'tenant'), `${tm.name} aa rahe hain: ${ob.slot}.`, 'R4', 'tell tenant the slot', ob);
    if (!ob.notes.includes('awaiting_approval')) {
      await this.buttons(ctx, this.party(ctx, 'owner'), `Booked ${tm.name} for ${ob.title}, ${ob.slot}, ${this.rupees(ob.quote_paise)} (within your limit). Paid only after the tenant confirms.`, [{ id: `ok:${ob.obligation_id}`, title: 'OK' }, { id: `cancel:${ob.obligation_id}`, title: 'Cancel' }, { id: `notmine:${ob.obligation_id}`, title: 'Not responsible' }], 'R7', 'inform owner with cancel window', ob);
    }
    if (ob.part) await this.shipPart(ctx, ob, tm);
    return out;
  }

  async shipPart(ctx, ob, tm) {
    const pin = await this.call('dlv', 'pincode_serviceability', { pincode: ctx.tenancy.pincode });
    const codes = pin.data?.body?.delivery_codes;
    const serviceable = pin.ok && Array.isArray(codes) && codes.some((c) => c.postal_code?.pre_paid === 'Y');
    let reason = serviceable ? '' : 'pincode not serviceable';
    let stock;
    if (serviceable) {
      stock = await this.call('caps', 'fulfillment_stock', { pincode: ctx.tenancy.pincode, sku: ob.part });
      if (!stock.ok || !stock.data?.body?.in_stock) reason = 'part out of stock nearby';
    }
    if (!reason) {
      const sh = await this.call('dlv', 'create_shipment', { order_id: `${ob.obligation_id}-part`, consignee_name: this.party(ctx, 'tenant').name, address: ctx.tenancy.address, pincode: ctx.tenancy.pincode, city: ctx.tenancy.city, state: ctx.tenancy.state, products_desc: ob.part, pickup_location: stock.data.body.centres[0].seller_pickup_location });
      const wb = sh.ok && typeof sh.data.body === 'object' && sh.data.body.success && sh.data.body.packages?.[0]?.waybill;
      if (wb) {
        await this.patch(ob, { waybill: wb });
        await this.audit(ctx, { obligation_id: ob.obligation_id, decision: `part shipped, waybill ${wb}`, rule: 'R17', action: 'create_shipment', via_connector: 'tenly_delhivery', external_ref: wb });
        await this.text(ctx, tm, `Part (${ob.part}) is coming by Delhivery, waybill ${wb}. I will tell you when it is delivered.`, 'R17', 'tell tradesman about the part', ob);
        return;
      }
      reason = `shipment failed (${typeof sh.data.body === 'object' ? sh.data.body.rmk || `http ${sh.data.http_status}` : 'malformed reply'})`;
    }
    await this.audit(ctx, { obligation_id: ob.obligation_id, decision: `cannot ship part: ${reason}; tradesman brings it`, rule: 'R17/R18', via_connector: 'tenly_delhivery' });
    await this.text(ctx, tm, `Please bring the part yourself (${ob.part}): ${reason}. Tell me if the quote changes.`, 'R17', 'ask tradesman to bring the part', ob);
  }

  // ---------- owner ----------
  async onOwner(ctx, who, out) {
    const tx = await this.transcript(ctx, who);
    const pending = ctx.obligations.find((o) => o.notes.includes('awaiting_approval') && o.state !== 'IN_PROGRESS' && o.state !== 'CLOSED');
    if (pending && /\b(haan|han|yes|approve|kar do|karwa do|theek hai|ok)\b/i.test(tx) && !/\b(nahi|no|mat)\b/i.test(tx)) {
      await this.audit(ctx, { obligation_id: pending.obligation_id, decision: 'owner approved by voice note', rule: 'R10', input_summary: tx, source_connector: 'tenly_gnani', source_ref: ctx.event.event_id });
      if (pending.state === 'ESCALATED') { await this.setState(ctx, pending, 'NOTIFIED'); }
      return this.book(ctx, pending, out);
    }
    if (pending && tx) {
      await this.buttons(ctx, who, `Just to confirm, ${pending.title}: approve ${this.rupees(pending.quote_paise)}?`, [{ id: `approve:${pending.obligation_id}`, title: 'Approve' }, { id: `decline:${pending.obligation_id}`, title: 'Decline' }], 'R10', 'ambiguous owner reply: confirm with buttons', pending);
    }
    return out;
  }

  // ---------- buttons ----------
  async onButton(ctx, who, out) {
    const [act, obId] = (ctx.event.button_id || '').split(':');
    const ob = ctx.obligations.find((o) => o.obligation_id === obId);
    if (!ob) return out;
    const owner = this.party(ctx, 'owner'); const tenant = this.party(ctx, 'tenant');
    const tm = ctx.parties.find((p) => p.msisdn === ob.vendor_msisdn);
    if (who.role === 'owner' && act === 'ok') { await this.audit(ctx, { obligation_id: ob.obligation_id, decision: 'owner acknowledged booking', rule: 'R7' }); return out; }
    if (who.role === 'owner' && act === 'approve') {
      await this.audit(ctx, { obligation_id: ob.obligation_id, decision: 'owner approved over-limit quote', rule: 'R10', source_connector: 'whatsapp', source_ref: ctx.event.event_id });
      if (ob.state === 'ESCALATED') await this.setState(ctx, ob, 'NOTIFIED');
      return this.book(ctx, ob, out);
    }
    if (who.role === 'owner' && (act === 'cancel' || act === 'notmine')) {
      if (ob.waybill) {
        const c = await this.call('dlv', 'cancel_shipment', { waybill: ob.waybill });
        await this.audit(ctx, { obligation_id: ob.obligation_id, decision: c.data?.body?.status ? 'part shipment cancelled' : `could not cancel shipment: ${c.data?.body?.remark || 'error'}`, rule: 'R17', via_connector: 'tenly_delhivery', external_ref: ob.waybill });
      }
      if (tm) await this.text(ctx, tm, `Cancelled: ${ob.title} at ${ctx.tenancy.flat}. Please do not go.`, 'R17', 'cancel tradesman booking', ob);
      if (act === 'cancel') {
        const from = await this.setState(ctx, ob, 'NOTIFIED', { notes: `${ob.notes};owner_self_handling`, next_action_at: ob.due_at });
        await this.audit(ctx, { obligation_id: ob.obligation_id, state_from: from, state_to: 'NOTIFIED', decision: 'owner will handle it himself', rule: 'R7' });
        await this.text(ctx, tenant, `${owner.name} will arrange the repair himself by ${ob.due_at.slice(0, 10)}. I will keep track.`, 'R4', 'tell tenant owner is handling it', ob);
        return out;
      }
      const clauses = JSON.parse(ctx.tenancy.clauses_json);
      const cid = ob.source_ref.replace('clause ', '');
      const from = await this.setState(ctx, ob, 'DISPUTED');
      await this.audit(ctx, { obligation_id: ob.obligation_id, state_from: from, state_to: 'DISPUTED', decision: 'owner disputes responsibility; a neutral reviewer decides', rule: 'R16', source_connector: 'whatsapp', source_ref: ctx.event.event_id });
      const evidence = `Clause ${cid}: "${clauses[cid]}". Reported: "${ob.title}".`;
      await this.text(ctx, owner, `Noted. This is now with a neutral reviewer. The evidence both sides see: ${evidence}`, 'R16', 'same evidence to owner', ob);
      await this.text(ctx, tenant, `${owner.name} says this is not his responsibility. A neutral reviewer will decide. The evidence both sides see: ${evidence}`, 'R16', 'same evidence to tenant', ob);
      out.needs_review = true; out.review_reason = 'owner disputes clause 7(b) responsibility'; out.obligation_id = ob.obligation_id;
      return out;
    }
    if (who.role === 'owner' && act === 'decline') {
      await this.text(ctx, owner, 'Understood. Should I find another quote, or will you arrange it yourself?', 'R8', 'owner declined: ask next step', ob);
      return out;
    }
    if (who.role === 'tenant' && act === 'broken') {
      const from = await this.setState(ctx, ob, 'IN_PROGRESS', { proof_tradesman_msg_id: '' });
      await this.audit(ctx, { obligation_id: ob.obligation_id, state_from: from, state_to: 'IN_PROGRESS', decision: 'tenant says still broken: no payment, rework', rule: 'R11' });
      if (tm) await this.text(ctx, tm, `Priya says it is still broken. Please go back; payment waits until she confirms.`, 'R11', 'send tradesman back', ob);
      return out;
    }
    if (who.role === 'tenant' && act === 'fixed') {
      await this.patch(ob, { proof_tenant_msg_id: ctx.event.event_id });
      await this.audit(ctx, { obligation_id: ob.obligation_id, decision: 'tenant confirmed the fix', rule: 'R11', source_connector: 'whatsapp', source_ref: ctx.event.event_id });
      return this.pay(ctx, ob, out);
    }
    return out;
  }

  async pay(ctx, ob, out) {
    const amount = Number(ob.amount_paise || ob.quote_paise);
    const tm = ctx.parties.find((p) => p.msisdn === ob.vendor_msisdn);
    const bal = await this.call('p3p', 'getMandateBalance', { authorizationId: ctx.tenancy.mandate_id });
    const b = bal.data?.body || {};
    const remaining = b.balance_details?.amount_remaining?.value ?? 0;
    const payable = bal.ok && b.status === 'ACTIVE' && amount <= Number(ctx.tenancy.per_job_limit_paise) && amount <= remaining;
    await this.audit(ctx, { obligation_id: ob.obligation_id, decision: payable ? `pay ${this.rupees(amount)} from mandate (remaining ${this.rupees(remaining)})` : `cannot pay from mandate (status ${b.status}, remaining ${this.rupees(remaining)}, amount ${this.rupees(amount)}): payment link`, rule: 'R12', via_connector: 'tenly_p3p' });
    if (!payable) return this.paymentLink(ctx, ob, amount, out);
    const maxRetries = this.cfg(ctx, 'max_retries');
    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
      const key = `${ob.obligation_id}-pay-1`; // same key across retries: R13, never pays twice
      const r = attempt === 1
        ? await this.call('caps', 'payout_individual', { idempotency_key: key, mandate_id: ctx.tenancy.mandate_id, amount_paise: amount, payee_vpa: tm.upi_vpa, payee_name: tm.name, obligation_id: ob.obligation_id, proof_tradesman_msg_id: ob.proof_tradesman_msg_id, proof_tenant_confirm_msg_id: ob.proof_tenant_msg_id })
        : await this.call('caps', 'payout_status', { idempotency_key: key });
      const body = typeof r.data?.body === 'object' ? r.data.body : {};
      if (r.ok && body.status === 'SUCCESS' && body.utr) {
        const from = await this.setState(ctx, ob, 'CLOSED', { utr: body.utr, payout_id: body.payout_id });
        await this.audit(ctx, { obligation_id: ob.obligation_id, state_from: from, state_to: 'CLOSED', decision: `paid ${tm.name} ${this.rupees(amount)}`, rule: 'R13', via_connector: 'tenly_caps', external_ref: body.utr });
        for (const p of [tm, this.party(ctx, 'tenant'), this.party(ctx, 'owner')]) {
          await this.text(ctx, p, `Closed: ${ob.title}. ${tm.name} paid ${this.rupees(amount)}, UTR ${body.utr}. Photos and confirmation are on the shared record.`, 'R14', 'close and tell all three', ob);
        }
        return out;
      }
      if (r.ok && body.status === 'PENDING') {
        await this.patch(ob, { payout_id: body.payout_id, next_action_at: ctx.now });
        await this.audit(ctx, { obligation_id: ob.obligation_id, decision: 'payout pending: check status on next tick', rule: 'R13' });
        return out;
      }
      await this.audit(ctx, { obligation_id: ob.obligation_id, decision: `payout attempt ${attempt} not confirmed (http ${r.data?.http_status}); check status by key before any retry`, rule: 'R13/R18', via_connector: 'tenly_caps' });
      if ([402, 403, 409, 422].includes(r.data?.http_status)) return this.paymentLink(ctx, ob, amount, out);
    }
    const from = await this.setState(ctx, ob, 'ESCALATED');
    await this.audit(ctx, { obligation_id: ob.obligation_id, state_from: from, state_to: 'ESCALATED', decision: 'payout unconfirmed after retries', rule: 'R13' });
    return this.paymentLink(ctx, ob, amount, out);
  }

  async paymentLink(ctx, ob, amount, out) {
    const link = await this.plural.create_payment_link({ amount, merchant_order_reference: `${ob.obligation_id}-link` });
    await this.patch(ob, { payment_link_ref: link.order_id, next_action_at: ctx.now });
    await this.text(ctx, this.party(ctx, 'owner'), `Please pay ${this.rupees(amount)} for ${ob.title} with this Pine Labs link: ${link.url}`, 'R12', 'send owner Plural payment link', ob);
    return out;
  }

  async pauseAck(ctx, who, word, out) {
    const msg = word === 'RESUME' ? `TenLy has resumed for ${ctx.tenancy.flat}.` : `Everything for ${ctx.tenancy.flat} is paused by the ${who.role}. Only the ${who.role} can send RESUME.`;
    for (const role of ['tenant', 'owner']) await this.text(ctx, this.party(ctx, role), msg, 'R15', `${word.toLowerCase()} confirmed to both`);
    return out;
  }

  // ---------- sweep (R9 ladder, tracking, pending payouts, payment links) ----------
  async sweep() {
    const run_id = `${this.runPrefix}-${++this.runSeq}`;
    const event = { event_type: 'tick', event_id: `tick-${run_id}`, tenancy_id: 'T-302' };
    const ctx = await this.context(event, run_id);
    const out = { event_id: event.event_id, run_id, decisions: ctx.decisions, needs_review: false };
    if (ctx.tenancy.paused === 'TRUE') return out;
    const now = Date.parse(ctx.now);
    for (const ob of ctx.obligations) {
      if (['CLOSED', 'DISPUTED'].includes(ob.state) || !ob.next_action_at || Date.parse(ob.next_action_at) > now) continue;
      const owner = this.party(ctx, 'owner');
      if (ob.notes.includes('awaiting_approval') && ['NOTIFIED', 'ESCALATED'].includes(ob.state)) {
        const step = Number(ob.ladder_step || 0);
        if (step === 0) {
          await this.text(ctx, owner, `Reminder: ${ob.title} is waiting for your approval (${this.rupees(ob.quote_paise)}).`, 'R9', 'owner silent: text reminder', ob);
          await this.patch(ob, { ladder_step: '1', next_action_at: this.later(ctx, this.cfg(ctx, 'owner_voice_after') - this.cfg(ctx, 'owner_reminder_after')) });
        } else if (step === 1) {
          await this.voice(ctx, owner, `Namaste ${owner.name}, ${ctx.tenancy.flat} mein ${ob.title} aapki approval ka intezaar kar raha hai. Kripya approve karein.`, 'hi-IN', ob);
          await this.patch(ob, { ladder_step: '2', next_action_at: this.later(ctx, this.cfg(ctx, 'escalate_after') - this.cfg(ctx, 'owner_voice_after')) });
        } else if (step === 2 && ob.state !== 'ESCALATED') {
          const from = await this.setState(ctx, ob, 'ESCALATED', { next_action_at: '' });
          await this.audit(ctx, { obligation_id: ob.obligation_id, state_from: from, state_to: 'ESCALATED', decision: 'ladder exhausted: escalated', rule: 'R9' });
          for (const p of [owner, this.party(ctx, 'tenant')]) await this.text(ctx, p, `Stuck: ${ob.title} has waited for approval since ${ob.state_since.slice(0, 16)}. Nothing moves until ${owner.name} approves or declines.`, 'R9', 'tell both what is stuck', ob);
        }
        continue;
      }
      if (ob.state === 'IN_PROGRESS' && ob.waybill && !ob.notes.includes('part_delivered')) {
        const t = await this.call('dlv', 'track_shipment', { waybill: ob.waybill });
        const st = t.data?.body?.ShipmentData?.[0]?.Shipment?.Status?.Status;
        if (st === 'Delivered') {
          await this.patch(ob, { notes: `${ob.notes};part_delivered` });
          await this.audit(ctx, { obligation_id: ob.obligation_id, decision: 'part delivered', rule: 'R17', via_connector: 'tenly_delhivery', external_ref: ob.waybill });
          const tm = ctx.parties.find((p) => p.msisdn === ob.vendor_msisdn);
          await this.text(ctx, tm, `The part for ${ob.title} has been delivered to ${ctx.tenancy.flat}.`, 'R17', 'tell tradesman part delivered', ob);
        } else if (st === 'Undelivered') {
          await this.audit(ctx, { obligation_id: ob.obligation_id, decision: 'part undelivered (NDR): ask tenant for a new slot', rule: 'R17', external_ref: ob.waybill });
          await this.text(ctx, this.party(ctx, 'tenant'), `Delhivery could not deliver the part for ${ob.title}. When should they come again?`, 'R17', 'NDR: ask tenant for slot', ob);
        }
      }
      if (ob.payout_id && !ob.utr) {
        const s = await this.call('caps', 'payout_status', { idempotency_key: `${ob.obligation_id}-pay-1` });
        const body = s.data?.body || {};
        if (body.status === 'SUCCESS' && body.utr) {
          const from = await this.setState(ctx, ob, 'CLOSED', { utr: body.utr });
          await this.audit(ctx, { obligation_id: ob.obligation_id, state_from: from, state_to: 'CLOSED', decision: 'pending payout confirmed', rule: 'R13', external_ref: body.utr });
        }
      }
      if (ob.payment_link_ref && ob.state === 'PROOF_CHECK') {
        const s = await this.plural.get_order_status({ order_id: ob.payment_link_ref });
        if (s.status === 'PAID') {
          const from = await this.setState(ctx, ob, 'CLOSED');
          await this.audit(ctx, { obligation_id: ob.obligation_id, state_from: from, state_to: 'CLOSED', decision: 'owner paid by Plural link', rule: 'R12', external_ref: ob.payment_link_ref });
        }
      }
    }
    return out;
  }
}
