// The shared tenancy record. Column order is the Google Sheet's column order.
export const SCHEMA = {
  Tenancy: ['tenancy_id', 'flat', 'address', 'pincode', 'city', 'state', 'rent_paise', 'rent_due_day',
    'deposit_paise', 'clauses_json', 'per_job_limit_paise', 'monthly_cap_paise', 'extension_policy',
    'mandate_id', 'owner_mandate_phone', 'paused', 'paused_by'],
  Parties: ['msisdn', 'tenancy_id', 'role', 'name', 'language', 'call_hours', 'consent_at', 'trades', 'upi_vpa'],
  Obligations: ['obligation_id', 'tenancy_id', 'type', 'title', 'owed_by', 'owed_to', 'source_type', 'source_ref',
    'amount_paise', 'due_at', 'state', 'state_since', 'next_action_at', 'ladder_step', 'vendor_msisdn',
    'quote_paise', 'slot', 'part', 'waybill', 'payout_id', 'utr', 'payment_link_ref',
    'proof_tradesman_msg_id', 'proof_tenant_msg_id', 'review_ref', 'notes', 'updated_by_run'],
  Audit: ['audit_id', 'ts_ist', 'event_id', 'run_id', 'actor', 'tenancy_id', 'obligation_id', 'state_from',
    'state_to', 'input_summary', 'source_connector', 'source_ref', 'decision', 'rule', 'action', 'to',
    'message_text', 'via_connector', 'result', 'external_ref', 'prompt_version'],
  Config: ['key', 'value_prod', 'value_demo', 'unit'],
  Inbox: ['event_id', 'received_at', 'tenancy_id', 'from_msisdn', 'from_role', 'message_type', 'text',
    'button_id', 'media_url', 'context_msg_id', 'processed', 'run_id'],
};

export const STATES = ['RECORDED', 'NOTIFIED', 'IN_PROGRESS', 'PROOF_CHECK', 'CLOSED', 'ESCALATED', 'DISPUTED'];

// Allowed obligation state changes (Q3 of the Round 2 submission).
export const TRANSITIONS = {
  RECORDED: ['NOTIFIED', 'DISPUTED'],
  NOTIFIED: ['IN_PROGRESS', 'ESCALATED', 'DISPUTED'],
  IN_PROGRESS: ['PROOF_CHECK', 'ESCALATED', 'DISPUTED', 'NOTIFIED'],
  PROOF_CHECK: ['CLOSED', 'IN_PROGRESS', 'DISPUTED'],
  ESCALATED: ['NOTIFIED', 'IN_PROGRESS', 'DISPUTED'],
  DISPUTED: ['NOTIFIED', 'IN_PROGRESS', 'CLOSED'], // only with a review_ref (a human decision)
  CLOSED: ['IN_PROGRESS'], // rework within the guarantee window
};

export const DEMO_SEED = {
  Tenancy: [{
    tenancy_id: 'T-302', flat: 'Flat 302, Lakeview Residency', address: '14 5th Cross, Koramangala 4th Block',
    pincode: '560034', city: 'Bengaluru', state: 'Karnataka', rent_paise: '2500000', rent_due_day: '5',
    deposit_paise: '5000000',
    clauses_json: JSON.stringify({
      '7b': 'Owner handles plumbing and electrical repairs.',
      '7c': 'Tenant handles damage caused by tenant misuse.',
      '9': 'Rent is due on the 5th of every month by UPI.',
      '11': 'Either party gives two months notice to end the tenancy.',
    }),
    per_job_limit_paise: '400000', monthly_cap_paise: '800000',
    extension_policy: 'up to 5 days, once a quarter', mandate_id: 'MND-302', owner_mandate_phone: '',
    paused: 'FALSE', paused_by: '',
  }],
  Parties: [
    { msisdn: process.env.DEMO_TENANT_MSISDN || '919000000001', tenancy_id: 'T-302', role: 'tenant', name: 'Priya', language: process.env.DEMO_TENANT_LANG || 'hi', call_hours: '09:00-20:00', consent_at: '2026-10-01T10:00:00+05:30', trades: '', upi_vpa: '' },
    { msisdn: process.env.DEMO_OWNER_MSISDN || '919000000002', tenancy_id: 'T-302', role: 'owner', name: 'Mr Sharma', language: 'hi', call_hours: '09:00-20:00', consent_at: '2026-10-01T10:05:00+05:30', trades: '', upi_vpa: '' },
    { msisdn: process.env.DEMO_TRADESMAN_MSISDN || '919000000003', tenancy_id: 'T-302', role: 'tradesman', name: 'Raju', language: 'hi', call_hours: '08:00-21:00', consent_at: '2026-10-01T10:10:00+05:30', trades: 'plumbing,electrical', upi_vpa: 'raju.plumber@okaxis' },
  ],
  Config: [
    { key: 'demo_mode', value_prod: 'FALSE', value_demo: 'TRUE', unit: 'bool' },
    { key: 'cancel_window', value_prod: '120', value_demo: '2', unit: 'minutes' },
    { key: 'owner_reminder_after', value_prod: '1440', value_demo: '3', unit: 'minutes' },
    { key: 'owner_voice_after', value_prod: '2880', value_demo: '6', unit: 'minutes' },
    { key: 'escalate_after', value_prod: '4320', value_demo: '9', unit: 'minutes' },
    { key: 'proof_wait', value_prod: '1440', value_demo: '5', unit: 'minutes' },
    { key: 'repair_due', value_prod: '2880', value_demo: '15', unit: 'minutes' },
    { key: 'max_retries', value_prod: '3', value_demo: '3', unit: 'count' },
  ],
  Obligations: [], Audit: [], Inbox: [],
};
