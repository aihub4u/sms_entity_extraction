'use strict';

/**
 * Runs every SMS in samples/sms-samples.json against a running API.
 *   API_URL=http://localhost:3000 node scripts/run-samples.js ["I didn't do this transaction"]
 */
const samples = require('../samples/sms-samples.json');

const API_URL = process.env.API_URL || 'http://localhost:3000';
const API_KEY = process.env.API_KEY || '';
const customerMessage = process.argv[2] || "I didn't do this transaction";

(async () => {
  for (const s of samples) {
    const res = await fetch(`${API_URL}/v1/transactions/extract`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(API_KEY ? { 'x-api-key': API_KEY } : {}) },
      body: JSON.stringify({
        twix_request_id: `sample-${s.id}`,
        mobile_number: '919130548824',
        sms_text: s.sms_text,
        customer_message: customerMessage,
      }),
    });
    const r = await res.json();
    if (!res.ok) { console.log(`\n✗ ${s.label}\n`, r); continue; }
    console.log(`\n■ ${s.label}`);
    console.log(`  status=${r.status} kind=${r.message_kind} otp=${r.otp_detected} confidence=${r.meta.confidence} llm_ms=${r.meta.llm_latency_ms}`);
    console.log('  sbi fields:', JSON.stringify(Object.fromEntries(['txnNo', 'amount', 'date', 'time', 'merchant', 'account_card_det', 'txnType'].map((k) => [k, r.transaction[k]]))));
    console.log(`  extra: drCr=${r.transaction.dr_cr} status=${r.transaction.txn_status} channel=${r.transaction.channel} ref_type=${r.transaction.ref_type}`);
    console.log(`  complaint: ${r.complaint.category_label} / ${r.complaint.complaint_type} / escalate=${r.complaint.escalation_required}`);
    if (r.missing_fields.length) console.log('  missing:', r.missing_fields.join(', '));
    if (r.warnings.length) console.log('  warnings:', r.warnings.map((w) => w.code).join(', '));
  }
})().catch((e) => { console.error(e); process.exit(1); });
