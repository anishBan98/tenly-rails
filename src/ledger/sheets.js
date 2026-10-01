// Google Sheets ledger over the real Sheets REST API, authenticated with a service account
// (RS256 JWT signed with node:crypto, so no googleapis dependency). Share the spreadsheet with
// the service account's client_email as Editor.
import { createSign } from 'node:crypto';
import { SCHEMA } from './schema.js';

const colLetter = (n) => { let s = ''; n += 1; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };

export function createSheetsLedger({ sheetId, saJson }) {
  const sa = typeof saJson === 'string' ? JSON.parse(saJson) : saJson;
  let token = null; let tokenExp = 0;
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}`;

  async function accessToken() {
    if (token && Date.now() < tokenExp - 60000) return token;
    const now = Math.floor(Date.now() / 1000);
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({
      iss: sa.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
    })}`;
    const sig = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key).toString('base64url');
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }),
    });
    if (!r.ok) throw new Error(`Google token error ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    token = j.access_token; tokenExp = Date.now() + j.expires_in * 1000;
    return token;
  }

  async function api(path, init = {}) {
    const r = await fetch(`${base}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
    });
    if (!r.ok) throw new Error(`Sheets ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return r.json();
  }

  async function values(tab) {
    const j = await api(`/values/${encodeURIComponent(`${tab}!A1:${colLetter(SCHEMA[tab].length - 1)}`)}`);
    return j.values || [];
  }

  return {
    kind: 'sheets',
    async ensureTabs() {
      const meta = await api('?fields=sheets.properties.title');
      const have = new Set(meta.sheets.map((s) => s.properties.title));
      const add = Object.keys(SCHEMA).filter((t) => !have.has(t));
      if (add.length) {
        await api(':batchUpdate', { method: 'POST', body: JSON.stringify({ requests: add.map((title) => ({ addSheet: { properties: { title } } })) }) });
      }
      for (const tab of Object.keys(SCHEMA)) {
        await api(`/values/${encodeURIComponent(`${tab}!A1`)}?valueInputOption=RAW`, {
          method: 'PUT', body: JSON.stringify({ values: [SCHEMA[tab]] }),
        });
      }
    },
    async read(tab) {
      const [header, ...rows] = await values(tab);
      const cols = header || SCHEMA[tab];
      return rows.map((r) => Object.fromEntries(SCHEMA[tab].map((c) => [c, r[cols.indexOf(c)] ?? ''])));
    },
    async append(tab, rows) {
      const data = rows.map((r) => SCHEMA[tab].map((c) => (r[c] == null ? '' : String(r[c]))));
      await api(`/values/${encodeURIComponent(`${tab}!A1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
        method: 'POST', body: JSON.stringify({ values: data }),
      });
      return rows.length;
    },
    async updateWhere(tab, match, set) {
      const all = await values(tab);
      const [header, ...rows] = all;
      const cols = header || SCHEMA[tab];
      const updates = [];
      rows.forEach((r, i) => {
        const obj = Object.fromEntries(cols.map((c, j) => [c, r[j] ?? '']));
        if (Object.entries(match).every(([k, v]) => obj[k] === String(v))) {
          const next = SCHEMA[tab].map((c) => (c in set ? (set[c] == null ? '' : String(set[c])) : (obj[c] ?? '')));
          updates.push({ range: `${tab}!A${i + 2}:${colLetter(SCHEMA[tab].length - 1)}${i + 2}`, values: [next] });
        }
      });
      if (updates.length) {
        await api('/values:batchUpdate', { method: 'POST', body: JSON.stringify({ valueInputOption: 'RAW', data: updates }) });
      }
      return updates.length;
    },
    async clearAndSeed(seed) {
      for (const tab of Object.keys(SCHEMA)) {
        await api(`/values/${encodeURIComponent(`${tab}!A2:${colLetter(SCHEMA[tab].length - 1)}10000`)}:clear`, { method: 'POST', body: '{}' });
        if (seed[tab]?.length) await this.append(tab, seed[tab]);
      }
    },
  };
}
