# tenly-rails

Everything TenLy needs outside AgenticOrg, for The Ken Case-Build Competition, Round 3.

TenLy is **one agent on AgenticOrg** (Pine Labs' agent platform) that makes every decision.
This app gives it its tools, as MCP servers, plus the WhatsApp relay that feeds it events.

| MCP server | Path | Real or mock | Tools |
| --- | --- | --- | --- |
| `tenly_sheets` | `/mcp/sheets` | Real Google Sheets | `read_range`, `append_rows`, `update_range` |
| `tenly_gnani` | `/mcp/gnani` | Real Gnani | `stt` (`/stt/v3`), `tts` (`/api/v1/tts/inference`) |
| `tenly_wa_ui` | `/mcp/wa-ui` | Real WhatsApp Cloud API | `send_text_message`, `send_interactive_message`, `send_media_message` |
| `tenly_delhivery` | `/mcp/delhivery` | Mock, Delhivery's exact endpoints | `pincode_serviceability`, `create_shipment`, `pickup_request`, `track_shipment`, `cancel_shipment`, `ndr_action` |
| `tenly_p3p` | `/mcp/p3p` | Mock, P3P's method names | `createMandate`, `getMandateBalance`, `decidePayment` |
| `tenly_caps` | `/mcp/caps` | TenLy's new capabilities | `payout_individual`, `payout_status`, `split_debit`, `fulfillment_stock` |

The REST mocks answer on the providers' own paths too:
- Delhivery: `/c/api/pin-codes/json/`, `/api/cmu/create.json`, `/fm/request/new/`, `/api/v1/packages/json/`, `/api/p/edit`, `/api/p/update`
- P3P and the new capabilities: `/mpp/v1/balance`, `/mpp/v1/mandates`, `/mpp/v1/payments/decide`, `/mpp/v1/payouts/individual`, `/mpp/v1/payouts/{key}`, `/mpp/v1/mandates/split-debit`, `/api/v1/fulfillment/stock`

## Guardrails the model cannot talk its way around

- **Payouts:**
  - Refused without both proofs (422).
  - Refused above the grant limit of ₹4,000 (403).
  - Refused if the mandate balance is too low (402) or the mandate is inactive (409).
  - An `Idempotency-Key` is required, and a repeated key never pays twice.
- **Sheet:**
  - Only the obligation lifecycle's allowed moves are accepted.
  - A repair can't be closed without both proofs and a payment reference.
  - Leaving DISPUTED needs a human `review_ref`.
  - Audit is append-only.
  - Tenancy limits, Parties and Config are read-only to the agent.
- **WhatsApp:**
  - Only numbers in the Parties tab can be messaged.
  - Nothing goes out outside the recipient's call hours.
  - Button titles are limited to 20 characters.
- **Relay:**
  - Checks Meta's `X-Hub-Signature-256` signature.
  - Drops duplicate message IDs.
  - Takes the sender's role from the Sheet, never from message text.
  - Honours PAUSE/STOP and RESUME, and RESUME only from the person who paused.
- **Failure scenarios** are set by testers with `POST /mock/scenario`, never by the agent: timeouts, 500s, malformed JSON, HTML error pages, not-serviceable pincodes, no rider available, low balance, pending payouts and more.
- **Three independent audit writers** (relay, mocks and wrappers, agent). `scripts/reconcile.js` checks that their logs agree.

## Test

```bash
npm install
npm test          # 24 tests: Runs A/B/C end to end, 10 failure evals, guardrails, MCP + REST compliance
```

The end-to-end tests send signed WhatsApp webhooks through the relay. A reference agent that follows TenLy's rules then drives every tool over real MCP, using the official SDK client, and the three logs are reconciled at the end. The same servers have also been tested with the Python MCP client, the kind AgenticOrg's backend uses.

## Deploy (Vercel)

1. Push this folder to a GitHub repo, then import it in Vercel. No build step is needed; `api/index.js` serves everything.
2. Add Vercel KV (Upstash) to the project. It sets `KV_REST_API_URL` and `KV_REST_API_TOKEN`.
3. Set the env vars from `.env.example` and redeploy.
4. Seed the Sheet: `TENLY_MODE=live SHEET_ID=... GOOGLE_SA_JSON='...' node scripts/seed.js`. Put your teammates' numbers in `DEMO_SEED` first.
5. In Meta's app, set the webhook to `https://YOUR-APP/webhooks/whatsapp`, using your `META_VERIFY_TOKEN`, and subscribe to `messages`.
6. Reset before each recording: `curl -X POST https://YOUR-APP/mock/reset -H "x-admin-key: $ADMIN_KEY"`.

## Register on AgenticOrg (what worked on the live instance, 1 Oct 2026)

- **Names:** connector names are unique across the whole org, and base names such as `agent_scheduler` are reserved. Use `NAME_tenly`.
- **MCP connectors:** Connectors → Register Connector → tick **MCP** → Base URL `https://YOUR-APP/mcp/<path>` → Auth type Api Key → paste the matching `MCP_KEY_*`. Tools are discovered at registration. MCP connectors are visible only to whoever registers them, so one teammate owns the agent and every connector.
- **Connectors with no auth** (like `agent_scheduler_tenly`) register fine, but runs then fail with `missing_connector_config`. Fix it by re-saving the connector with any placeholder credential (`auth_config: {"api_key":"not-required"}`); the health check then turns green.
- **The firewall (CloudFront) rejects any request body over about 8 KB.** A 9 KB system prompt is silently refused (403), so keep the prompt under 7 KB. `prompts/tenly_system_prompt_v1.1.txt` is 5.9 KB.
- **Prompt edits** go through `PATCH /agents/{id}`. `PUT` needs every field.
- **Changing the review (HITL) condition** creates a pending approval for an admin. It is a governed change.
- **Model key:** runs fail with `LLMProviderConfigurationError` until the organisers add a model key to the tenant.

## Files

- `prompts/`: the system prompt, v1 (full) and v1.1 (the one deployed, under 8 KB)
- `src/`: the app (MCP servers, mocks, wrappers, relay, ledger with guardrails)
- `test/`: end-to-end, failure, guardrail and protocol tests, plus the reference agent
- `scripts/`: `reconcile.js` (log cross-check) and `seed.js` (sets up the Sheet)
