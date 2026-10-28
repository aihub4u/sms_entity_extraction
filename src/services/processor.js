'use strict';

const crypto = require('crypto');
const { groundTransaction } = require('./grounding');
const { toSbiDate, normalizeTime, formatAmount, daysBetween, parseIsoDate } = require('./normalize');
const { classify, advisoriesFor } = require('./complaintRules');

/** Fields in SBI's tentative JSON_COMPLAIN_REQ, in their order. */
const SBI_FIELDS = ['txnNo', 'amount', 'date', 'time', 'merchant', 'account_card_det', 'txnType'];

const QUESTIONS = {
  txnNo: 'Please share the transaction reference number (UTR / Ref No.) shown in your SMS or bank statement.',
  amount: 'What was the transaction amount?',
  date: 'On which date did the transaction happen?',
  time: 'Around what time did the transaction happen? (for example, 10:30 AM)',
  merchant: 'Who was the payment made to (merchant or person name)?',
  account_card_det: 'Please share the last 4 digits of the account or card that was debited.',
  txnType: 'How was the payment made? (UPI, IMPS, NEFT, card, etc.)',
  intent: 'What would you like to do about this transaction? For example: raise a dispute, report a failed transaction, or check a complaint status.',
  sms: 'Please forward or paste the debit SMS you received from the bank for this transaction.',
};

const REJECT_KINDS = new Set(['PROMOTIONAL', 'NOT_BANK_SMS', 'UNREADABLE']);

/** Maps the LLM's transaction object onto SBI's complaint fields. */
function toSbiFields(t) {
  return {
    txnNo: t.txn_ref_no || t.deposit_ref_no || t.bill_no || null,
    amount: formatAmount(t.amount),
    date: toSbiDate(t.date_iso),
    time: normalizeTime(t.time_24h),
    merchant: t.merchant || t.beneficiary_name || null,
    account_card_det: t.debit_account_masked || (t.dr_cr === 'CR' ? t.credit_account_masked : null) || null,
    txnType: t.txn_mode || null,
  };
}

/** Customer-supplied values (collected by the bot) override / fill SBI fields. */
function applyOverrides(fields, overrides) {
  const out = { ...fields };
  const provided = [];
  const errors = [];
  if (!overrides) return { fields: out, provided, errors };

  for (const [key, raw] of Object.entries(overrides)) {
    if (raw === null || raw === undefined || raw === '') continue;
    let value = raw;
    if (key === 'amount') {
      const n = typeof raw === 'number' ? raw : Number(String(raw).split(',').join(''));
      value = formatAmount(n);
    } else if (key === 'date') {
      value = toSbiDate(String(raw));
    } else if (key === 'time') {
      value = normalizeTime(String(raw));
    } else {
      value = String(raw).trim();
    }
    if (value === null) errors.push({ field: key, value: raw, message: `Invalid ${key}` });
    else { out[key] = value; provided.push(key); }
  }
  return { fields: out, provided, errors };
}

function sha256(s) {
  return s ? crypto.createHash('sha256').update(s).digest('hex') : null;
}

/**
 * Turns the raw LLM extraction into the API response. Pure and deterministic,
 * so it is reused by /finalize (no LLM call) once the bot has collected
 * missing fields from the customer.
 */
function buildResponse({ extraction, smsText, hasImage, overrides, twixRequestId, mobileNumber, config, today, meta = {} }) {
  const warnings = [];
  const kind = extraction.message_kind;

  // 1. Grounding (text input only)
  let txn = { ...extraction.transaction };
  let grounding = { checked: false, reason: hasImage && !smsText ? 'image_input' : 'no_source_text' };
  if (smsText) {
    const g = groundTransaction(txn, smsText);
    txn = g.transaction;
    grounding = g.grounding;
    for (const d of grounding.dropped) {
      warnings.push({ code: 'UNGROUNDED_VALUE_DROPPED', field: d.field, message: `Extracted ${d.field} was not found in the SMS text and was discarded.` });
    }
  }

  // 2. Sanity checks on the date
  if (txn.date_iso && !parseIsoDate(txn.date_iso)) {
    warnings.push({ code: 'INVALID_DATE', field: 'date', message: `Could not interpret date "${txn.date_as_written || txn.date_iso}".` });
    txn.date_iso = null;
  }
  const age = txn.date_iso ? daysBetween(txn.date_iso, today) : null;
  if (age !== null && age < -1) warnings.push({ code: 'FUTURE_DATE', field: 'date', message: 'Transaction date is in the future; please confirm with the customer.' });
  if (age !== null && age > config.maxTxnAgeDays) warnings.push({ code: 'OLD_TRANSACTION', field: 'date', message: `Transaction is ${age} days old (limit ${config.maxTxnAgeDays}).` });
  if (txn.currency && txn.currency !== 'INR') warnings.push({ code: 'NON_INR_CURRENCY', field: 'amount', message: `Amount is in ${txn.currency}; SBI's current API has no currency field.` });

  if (kind === 'OTP') {
    warnings.push({ code: 'OTP_MESSAGE', message: 'This is an OTP message, not a transaction alert. It has no transaction reference; ask the customer for the debit SMS.' });
  }

  // 3. Map to SBI fields, then apply customer-supplied values
  const fromSms = toSbiFields(txn);
  const { fields, provided, errors } = applyOverrides(fromSms, overrides);
  for (const e of errors) warnings.push({ code: 'INVALID_OVERRIDE', field: e.field, message: `${e.message}: "${e.value}"` });

  // 4. Complaint classification (rules)
  const effectiveTxn = { ...txn, txn_mode: fields.txnType || txn.txn_mode };
  const complaint = classify({ txn: effectiveTxn, ctx: extraction.customer_context, config });

  // 5. Missing fields & bot follow-ups
  const missing = config.requiredFields.filter((f) => !fields[f]);
  if (!complaint.applicable && complaint.intent !== 'INFORMATION') missing.push('intent');
  if (kind === 'OTP' && !fields.txnNo) missing.unshift('sms');

  let status;
  if (!extraction.is_bank_message || REJECT_KINDS.has(kind)) status = 'REJECTED';
  else if (missing.length === 0) status = 'COMPLETE';
  else status = 'NEEDS_INPUT';

  const followUps = status === 'REJECTED'
    ? [{ field: 'sms', question: 'This does not look like a bank transaction message. ' + QUESTIONS.sms }]
    : [...new Set(missing)].map((f) => ({ field: f, question: QUESTIONS[f] || `Please provide ${f}.` }));

  // 6. Payloads
  const legacyBody = Object.fromEntries(SBI_FIELDS.map((k) => [k, fields[k] ?? '']));
  const sbiRequest = {
    twix_request_id: twixRequestId,
    mobile_number: mobileNumber,
    type: `JSON_COMPLAIN_REQ ${JSON.stringify(legacyBody)}`,
  };

  const fieldSource = Object.fromEntries(SBI_FIELDS.map((k) => [k, provided.includes(k) ? 'customer' : fields[k] ? (hasImage && !smsText ? 'screenshot' : 'sms') : null]));

  const sbiRequestExtended = {
    twix_request_id: twixRequestId,
    mobile_number: mobileNumber,
    request_type: complaint.applicable && complaint.category === 'STATUS_ENQUIRY' ? 'STATUS_ENQUIRY' : 'COMPLAINT',
    transaction: {
      ...legacyBody,
      refType: txn.ref_type,
      currency: txn.currency || 'INR',
      beneficiary_account: txn.credit_account_masked,
      beneficiary_name: txn.beneficiary_name,
      depositRefNo: txn.deposit_ref_no,
      billNo: txn.bill_no,
      drCr: txn.dr_cr,
      txnStatus: txn.txn_status,
      txnDescription: txn.txn_description,
      channel: txn.channel,
      failureReason: txn.failure_reason,
    },
    complaint: {
      intent: complaint.intent,
      category: complaint.category,
      reason: complaint.reason,
      complaintType: complaint.complaint_type,
      customerConfirmation: complaint.customer_confirmation.code,
      priority: complaint.priority,
      escalation: complaint.escalation_required,
      customerRemarks: complaint.customer_summary,
    },
    source: {
      inputType: hasImage && !smsText ? 'SCREENSHOT' : hasImage ? 'SMS_TEXT_AND_SCREENSHOT' : 'SMS_TEXT',
      messageKind: kind,
      rawSmsSha256: sha256(smsText),
      extractionConfidence: extraction.confidence,
      fieldSource,
      fieldsUserProvided: provided,
    },
  };

  return {
    status,
    ready_to_submit: status === 'COMPLETE' && complaint.applicable,
    message_kind: kind,
    bank_name: extraction.bank_name,
    otp_detected: extraction.otp_present,
    transaction: {
      ...fields,
      ref_type: txn.ref_type,
      currency: txn.currency,
      date_as_written: txn.date_as_written,
      dr_cr: txn.dr_cr,
      txn_status: txn.txn_status,
      txn_description: txn.txn_description,
      debit_account_masked: txn.debit_account_masked,
      credit_account_masked: txn.credit_account_masked,
      beneficiary_name: txn.beneficiary_name,
      deposit_ref_no: txn.deposit_ref_no,
      bill_no: txn.bill_no,
      channel: txn.channel,
      failure_reason: txn.failure_reason,
    },
    complaint,
    missing_fields: [...new Set(missing)],
    follow_up_questions: followUps,
    customer_advisories: advisoriesFor({ complaint, otpPresent: extraction.otp_present, config }),
    warnings,
    sbi_request: sbiRequest,
    sbi_request_extended: sbiRequestExtended,
    // Raw extraction (post-grounding) so the bot can call /finalize statelessly.
    extraction: { ...extraction, transaction: txn },
    meta: { ...meta, confidence: extraction.confidence, notes: extraction.extraction_notes, grounding },
  };
}

module.exports = { buildResponse, toSbiFields, applyOverrides, SBI_FIELDS };
