// Create the Sheet's tabs and headers, then seed the demo tenancy (T-302, Priya / Mr Sharma / Raju).
// Usage: TENLY_MODE=live SHEET_ID=... GOOGLE_SA_JSON='...' node scripts/seed.js
// Edit src/ledger/schema.js DEMO_SEED first: put your teammates' real WhatsApp numbers in Parties.
import { createSheetsLedger } from '../src/ledger/sheets.js';
import { DEMO_SEED } from '../src/ledger/schema.js';

const l = createSheetsLedger({ sheetId: process.env.SHEET_ID, saJson: process.env.GOOGLE_SA_JSON });
await l.ensureTabs();
await l.clearAndSeed(DEMO_SEED);
console.log('Sheet ready: tabs, headers and demo tenancy T-302 seeded.');
