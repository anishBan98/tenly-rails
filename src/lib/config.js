// Central configuration. Every secret comes from the environment; nothing is hard-coded.
// TENLY_MODE=local swaps the real Gnani, WhatsApp and Google Sheets clients for in-memory
// fakes, so the whole system can be tested end to end without any account.

const env = (k, d = '') => (process.env[k] ?? d);

export const config = {
  get mode() { return env('TENLY_MODE', 'local'); },           // local | live
  get baseUrl() { return env('PUBLIC_BASE_URL', 'http://localhost:8787').replace(/\/$/, ''); },
  get adminKey() { return env('ADMIN_KEY', 'dev-admin-key'); },
  get mediaSecret() { return env('MEDIA_SIGNING_SECRET', 'dev-media-secret'); },

  // API keys that AgenticOrg's MCP connectors send (header X-API-Key or Authorization: Bearer).
  mcpKeys: {
    get sheets() { return env('MCP_KEY_SHEETS', 'dev-sheets'); },
    get gnani() { return env('MCP_KEY_GNANI', 'dev-gnani'); },
    get waui() { return env('MCP_KEY_WAUI', 'dev-waui'); },
    get delhivery() { return env('MCP_KEY_DLV', 'dev-dlv'); },
    get p3p() { return env('MCP_KEY_P3P', 'dev-p3p'); },
    get caps() { return env('MCP_KEY_CAPS', 'dev-caps'); },
  },
  // Keys for the REST mocks (what a Delhivery / P3P client would send).
  get dlvToken() { return env('DLV_MOCK_KEY', 'dev-dlv-token'); },
  get p3pKey() { return env('P3P_MOCK_KEY', 'dev-p3p-key'); },
  get capsKey() { return env('CAPS_KEY', 'dev-caps-key'); },

  // Real tools (live mode only)
  get gnaniKey() { return env('GNANI_API_KEY'); },
  get gnaniSttUrl() { return env('GNANI_STT_URL', 'https://api.vachana.ai/stt/v3'); },
  get gnaniTtsUrl() { return env('GNANI_TTS_URL', 'https://api.vachana.ai/api/v1/tts/inference'); },
  get gnaniVoice() { return env('GNANI_VOICE', 'Nalini'); },
  get waToken() { return env('WA_TOKEN'); },
  get waPhoneId() { return env('WA_PHONE_NUMBER_ID'); },
  get graphBase() { return env('GRAPH_BASE', 'https://graph.facebook.com/v21.0'); },
  get metaAppSecret() { return env('META_APP_SECRET', 'dev-meta-secret'); },
  get metaVerifyToken() { return env('META_VERIFY_TOKEN', 'dev-verify'); },
  get sheetId() { return env('SHEET_ID'); },
  get googleSa() { return env('GOOGLE_SA_JSON'); },

  // AgenticOrg trigger (optional). Without a key the relay writes to the Inbox tab.
  get aoRunUrl() { return env('AGENTICORG_RUN_URL'); },
  get aoApiKey() { return env('AGENTICORG_API_KEY'); },

  // Business guardrails enforced server-side (defence in depth; the agent's grant is the first line).
  get grantMaxTxnPaise() { return Number(env('GRANT_MAX_TXN_PAISE', '400000')); },

  // Upstash / Vercel KV (optional; memory otherwise)
  get kvUrl() { return env('KV_REST_API_URL'); },
  get kvToken() { return env('KV_REST_API_TOKEN'); },
};

export const isLive = () => config.mode === 'live';
