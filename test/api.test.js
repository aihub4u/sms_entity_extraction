'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');

const UPI_SMS = 'Dear UPI user A/C X1282 debited by 106.00 on date 23Jun26 trf to RAMESH KEDARNATH Refno 388062945190 If not u? call-1800111109 for other services-18001234-SBI';
const FASTAG_SMS = 'ICICI Bank FASTag bill 1782288677542 of Rs.200.00 has failed.Pl try again.-YONO SBI';
const OTP_SMS = '482913 is OTP for your NEFT Trf of Rs.52.00 through Yono Lite SBI. Do not share this with anyone. Bank will NEVER call you to verify it.-SBI';

const txn = (o = {}) => ({
  txn_ref_no: null, ref_type: null, amount: null, currency: 'INR', date_iso: null, date_as_written: null,
  time_24h: null, dr_cr: null, txn_status: null, txn_mode: null, txn_description: null,
  debit_account_masked: null, credit_account_masked: null, beneficiary_name: null, merchant: null,
  deposit_ref_no: null, bill_no: null, channel: null, failure_reason: null, ...o,
});
const ctx = (o = {}) => ({ intent: 'NONE', reason: 'NONE', customer_denies_transaction: null, summary: null, ...o });
const llm = (o = {}) => ({ message_kind: 'TRANSACTION_ALERT', is_bank_message: true, bank_name: 'SBI', otp_present: false, confidence: 0.95, extraction_notes: [], ...o });

// What a correct model returns for each fixture SMS (keyed by text).
const FIXTURES = {
  [UPI_SMS]: (cm) => llm({
    transaction: txn({ txn_ref_no: '388062945190', ref_type: 'UPI_RRN', amount: 106, date_iso: '2026-06-23', date_as_written: '23Jun26', dr_cr: 'DR', txn_status: 'SUCCESS', txn_mode: 'upi', txn_description: 'UPI Transfer', debit_account_masked: 'X1282', beneficiary_name: 'RAMESH KEDARNATH', channel: 'UPI' }),
    customer_context: cm ? ctx({ intent: 'RAISE_DISPUTE', reason: 'UNAUTHORISED_TRANSACTION', customer_denies_transaction: true, summary: 'Customer says they did not do this transaction' }) : ctx(),
  }),
  [FASTAG_SMS]: () => llm({
    transaction: txn({ txn_ref_no: '1782288677542', ref_type: 'BILL_NO', amount: 200, txn_status: 'FAILED', txn_mode: 'fastag', txn_description: 'FASTag Bill Payment', merchant: 'ICICI Bank FASTag', bill_no: '1782288677542', channel: 'YONO SBI', failure_reason: 'Transaction failed' }),
    customer_context: ctx({ intent: 'RAISE_DISPUTE', reason: 'FAILED_BUT_DEBITED', customer_denies_transaction: false, summary: 'Money deducted but payment failed' }),
  }),
  [OTP_SMS]: () => llm({
    message_kind: 'OTP', otp_present: true,
    transaction: txn({ amount: 52, txn_status: 'INITIATED', txn_mode: 'neft', txn_description: 'NEFT Transfer', channel: 'Yono Lite SBI' }),
    customer_context: ctx({ intent: 'RAISE_DISPUTE', reason: 'UNAUTHORISED_TRANSACTION', customer_denies_transaction: true }),
  }),
  'Flat 50% off on loans! Apply now': () => llm({ message_kind: 'PROMOTIONAL', is_bank_message: false, transaction: txn(), customer_context: ctx() }),
  'HALLUCINATION Your a/c x1111 debited Rs.5.00': () => llm({
    transaction: txn({ txn_ref_no: '999999999999', amount: 5, debit_account_masked: 'x1111', txn_mode: 'upi', date_iso: '2026-10-01', dr_cr: 'DR', txn_status: 'SUCCESS' }),
    customer_context: ctx({ intent: 'RAISE_DISPUTE', reason: 'UNAUTHORISED_TRANSACTION', customer_denies_transaction: true }),
  }),
};

const config = {
  apiKey: 'test-key', openaiModel: 'stub', openaiApiKey: 'x', timeZone: 'Asia/Kolkata',
  requiredFields: ['txnNo', 'amount', 'date', 'time', 'account_card_det', 'txnType'],
  escalationAmountThreshold: 100000, maxTxnAgeDays: 365, bankHelpline: '1800111109',
  sbiComplaintApiUrl: null, maxBodyMb: 8,
};

const calls = [];
const extract = async ({ smsText, customerMessage }) => {
  calls.push({ smsText, customerMessage });
  const f = FIXTURES[smsText];
  if (!f) throw Object.assign(new Error('no fixture'), { status: 500 });
  return { data: f(customerMessage), model: 'stub', usage: null };
};

const normCalls = [];
const llmNormalize = async (p) => {
  normCalls.push(p);
  const known = p.text === 'last Monday evening around 7';
  return { date_iso: known ? '2026-10-26' : null, time_24h: known ? '19:00' : null, amount: null, model: 'stub-norm' };
};

let server; let base;
before(async () => {
  server = createApp({ config, extract, llmNormalize }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const post = async (path, body, key = 'test-key') => {
  const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const req = (o) => ({ twix_request_id: '664c2cb3f473982d64c36c55', mobile_number: '919130548824', ...o });

test('rejects missing/invalid api key', async () => {
  const r = await post('/v1/transactions/extract', req({ sms_text: UPI_SMS }), 'wrong');
  assert.equal(r.status, 401);
});

test('validates body', async () => {
  const r = await post('/v1/transactions/extract', req({ mobile_number: 'abc' }));
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'VALIDATION_ERROR');
});

test('UPI fraud: extracts fields, classifies, asks only for time', async () => {
  const r = await post('/v1/transactions/extract', req({ sms_text: UPI_SMS, customer_message: "I didn't do this transaction" }));
  assert.equal(r.status, 200);
  const b = r.body;
  assert.equal(b.status, 'NEEDS_INPUT');
  assert.deepEqual(b.missing_fields, ['time']);
  assert.equal(b.transaction.txnNo, '388062945190');
  assert.equal(b.transaction.amount, '106.00');
  assert.equal(b.transaction.date, '23-Jun-2026');
  assert.equal(b.transaction.merchant, 'RAMESH KEDARNATH');
  assert.equal(b.transaction.account_card_det, 'X1282');
  assert.equal(b.complaint.category, 'UPI_DISPUTE');
  assert.equal(b.complaint.category_label, 'UPI Dispute');
  assert.equal(b.complaint.complaint_type, 'FRAUDULENT_DEBIT');
  assert.equal(b.complaint.customer_confirmation.code, 'CUSTOMER_DENIES_TRANSACTION');
  assert.equal(b.complaint.escalation_required, true);
  assert.ok(b.customer_advisories.some((a) => a.code === 'CYBER_HELPLINE'));
  assert.equal(b.meta.grounding.dropped.length, 0);
  assert.equal(b.ready_to_submit, false);
});

test('UPI fraud with time override -> COMPLETE and valid SBI payload', async () => {
  const r = await post('/v1/transactions/extract', req({ sms_text: UPI_SMS, customer_message: 'not done by me', overrides: { time: '9:05' } }));
  const b = r.body;
  assert.equal(b.status, 'COMPLETE');
  assert.equal(b.ready_to_submit, true);
  assert.ok(b.sbi_request.type.startsWith('JSON_COMPLAIN_REQ '));
  const inner = JSON.parse(b.sbi_request.type.slice('JSON_COMPLAIN_REQ '.length));
  assert.deepEqual(inner, { txnNo: '388062945190', amount: '106.00', date: '23-Jun-2026', time: '09:05', merchant: 'RAMESH KEDARNATH', account_card_det: 'X1282', txnType: 'upi' });
  assert.deepEqual(b.sbi_request_extended.source.fieldsUserProvided, ['time']);
  assert.equal(b.sbi_request_extended.source.fieldSource.time, 'customer');
  assert.equal(b.sbi_request_extended.source.fieldSource.txnNo, 'sms');
  assert.equal(b.sbi_request_extended.transaction.drCr, 'DR');
});

test('no customer message -> asks for intent, complaint not applicable', async () => {
  const b = (await post('/v1/transactions/extract', req({ sms_text: UPI_SMS }))).body;
  assert.equal(b.complaint.applicable, false);
  assert.ok(b.missing_fields.includes('intent'));
});

test('failed FASTag -> FAILED_TRANSACTION, no escalation', async () => {
  const b = (await post('/v1/transactions/extract', req({ sms_text: FASTAG_SMS, customer_message: 'money deducted but failed' }))).body;
  assert.equal(b.complaint.category, 'FAILED_TRANSACTION');
  assert.equal(b.complaint.escalation_required, false);
  assert.equal(b.transaction.merchant, 'ICICI Bank FASTag');
  assert.deepEqual(b.missing_fields.sort(), ['account_card_det', 'date', 'time']);
});

test('OTP message is flagged and OTP never echoed', async () => {
  const b = (await post('/v1/transactions/extract', req({ sms_text: OTP_SMS, customer_message: 'I did not do this' }))).body;
  assert.equal(b.otp_detected, true);
  assert.equal(b.message_kind, 'OTP');
  assert.equal(b.missing_fields[0], 'sms');
  assert.ok(b.warnings.some((w) => w.code === 'OTP_MESSAGE'));
  assert.ok(b.customer_advisories.some((a) => a.code === 'OTP_SHARED'));
  assert.ok(!JSON.stringify(b).includes('482913'), 'OTP digits must not appear in response');
});

test('promotional SMS is rejected', async () => {
  const b = (await post('/v1/transactions/extract', req({ sms_text: 'Flat 50% off on loans! Apply now' }))).body;
  assert.equal(b.status, 'REJECTED');
});

test('hallucinated reference number is dropped by grounding', async () => {
  const b = (await post('/v1/transactions/extract', req({ sms_text: 'HALLUCINATION Your a/c x1111 debited Rs.5.00', customer_message: 'not me' }))).body;
  assert.equal(b.transaction.txnNo, null);
  assert.ok(b.missing_fields.includes('txnNo'));
  assert.ok(b.warnings.some((w) => w.code === 'UNGROUNDED_VALUE_DROPPED' && w.field === 'txn_ref_no'));
  assert.equal(b.transaction.account_card_det, 'x1111');
});

test('finalize completes a previous extraction without calling the LLM', async () => {
  const first = (await post('/v1/transactions/extract', req({ sms_text: FASTAG_SMS, customer_message: 'deducted but failed' }))).body;
  const before = calls.length;
  const nBefore = normCalls.length;
  const r = await post('/v1/complaints/finalize', req({ extraction: first.extraction, overrides: { time: '24/06/2026 18:40', account_card_det: 'x4666' } }));
  assert.equal(calls.length, before, 'no extraction LLM call');
  assert.equal(normCalls.length, nBefore, 'no normaliser LLM call');
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'COMPLETE');
  assert.equal(r.body.transaction.date, '24-Jun-2026');
  assert.equal(r.body.transaction.time, '18:40');
});

test('overrides.date is not accepted (only time)', async () => {
  const r = await post('/v1/transactions/extract', req({ sms_text: UPI_SMS, overrides: { date: '2026-06-24' } }));
  assert.equal(r.status, 400);
});

test('SMS without date: one follow-up on field "time" asking date and time', async () => {
  const b = (await post('/v1/transactions/extract', req({ sms_text: FASTAG_SMS, customer_message: 'deducted but failed' }))).body;
  assert.ok(b.missing_fields.includes('date') && b.missing_fields.includes('time'));
  const dt = b.follow_up_questions.filter((q) => q.field === 'time');
  assert.equal(dt.length, 1);
  assert.ok(!b.follow_up_questions.some((q) => q.field === 'date'));
  assert.ok(dt[0].question.includes('date') && dt[0].question.includes('time'));
});

test('overrides.time accepts date, time or both in any format', async () => {
  const first = (await post('/v1/transactions/extract', req({ sms_text: FASTAG_SMS, customer_message: 'deducted but failed' }))).body;
  for (const [text, expDate, expTime] of [
    ['24/06/2026 6:40 pm', '24-Jun-2026', '18:40'],
    ['24th June 18.40', '24-Jun-2026', '18:40'],
    ['6:40 PM on 24-06-26', '24-Jun-2026', '18:40'],
    ['June 24, 2026 1840', '24-Jun-2026', '18:40'],
  ]) {
    const r = (await post('/v1/complaints/finalize', req({ extraction: first.extraction, overrides: { time: text, account_card_det: 'x4666' } }))).body;
    assert.equal(r.status, 'COMPLETE', text);
    assert.equal(r.transaction.date, expDate, text);
    assert.equal(r.transaction.time, expTime, text);
    assert.ok(r.sbi_request.type.includes(`"date":"${expDate}"`));
  }
});

test('date-only answer in time: date filled, time asked next (still field "time")', async () => {
  const first = (await post('/v1/transactions/extract', req({ sms_text: FASTAG_SMS, customer_message: 'deducted but failed' }))).body;
  const r = (await post('/v1/complaints/finalize', req({ extraction: first.extraction, overrides: { time: '24 June', account_card_det: 'x4666' } }))).body;
  assert.equal(r.transaction.date, '24-Jun-2026');
  assert.equal(r.transaction.time, null);
  assert.deepEqual(r.missing_fields, ['time']);
  assert.deepEqual(r.follow_up_questions.map((q) => q.field), ['time']);
  assert.ok(!r.warnings.some((w) => w.code === 'INVALID_OVERRIDE'));
});

test('date in time answer never replaces the date from the SMS', async () => {
  const b = (await post('/v1/transactions/extract', req({ sms_text: UPI_SMS, customer_message: 'not me', overrides: { time: '25 June 7pm' } }))).body;
  assert.equal(b.transaction.date, '23-Jun-2026');
  assert.equal(b.transaction.time, '19:00');
  assert.equal(b.status, 'COMPLETE');
});

test('conversational answer falls back to the LLM; response shape unchanged', async () => {
  const first = (await post('/v1/transactions/extract', req({ sms_text: FASTAG_SMS, customer_message: 'deducted but failed' }))).body;
  const before = normCalls.length;
  const r = (await post('/v1/complaints/finalize', req({ extraction: first.extraction, overrides: { time: 'last Monday evening around 7', account_card_det: 'x4666' } }))).body;
  assert.equal(normCalls.length, before + 1);
  assert.equal(normCalls.at(-1).text, 'last Monday evening around 7');
  assert.equal(r.status, 'COMPLETE');
  assert.equal(r.transaction.date, '26-Oct-2026');
  assert.equal(r.transaction.time, '19:00');
  assert.deepEqual(Object.keys(r), Object.keys(first), 'same top-level response keys as /extract');
});

test('unreadable answer produces INVALID_OVERRIDE + same follow-up', async () => {
  const first = (await post('/v1/transactions/extract', req({ sms_text: FASTAG_SMS, customer_message: 'deducted but failed' }))).body;
  const r = (await post('/v1/complaints/finalize', req({ extraction: first.extraction, overrides: { time: 'no idea', account_card_det: 'x4666' } }))).body;
  assert.equal(r.status, 'NEEDS_INPUT');
  assert.ok(r.warnings.some((w) => w.code === 'INVALID_OVERRIDE' && w.field === 'time'));
  assert.deepEqual(r.follow_up_questions.map((q) => q.field), ['time']);
});

test('invalid override values are reported, not accepted', async () => {
  const b = (await post('/v1/transactions/extract', req({ sms_text: UPI_SMS, customer_message: 'not me', overrides: { time: '25:99' } }))).body;
  assert.ok(b.warnings.some((w) => w.code === 'INVALID_OVERRIDE'));
  assert.ok(b.missing_fields.includes('time'));
});

test('submit returns mock acknowledgement when SBI URL not configured', async () => {
  const first = (await post('/v1/transactions/extract', req({ sms_text: UPI_SMS, customer_message: 'not me', overrides: { time: '10:00' } }))).body;
  const r = await post('/v1/complaints/submit', first.sbi_request);
  assert.equal(r.status, 200);
  assert.equal(r.body.mock, true);
  assert.ok(r.body.complaint_id.startsWith('MOCK'));
});
