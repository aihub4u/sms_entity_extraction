'use strict';

/**
 * Deterministic complaint classification. The LLM only detects *what the
 * customer said* (intent + reason); the category, complaint type and
 * escalation are decided here so the bank can audit and tune the rules.
 */

const MODE_LABELS = {
  upi: 'UPI', imps: 'IMPS', neft: 'NEFT', rtgs: 'RTGS', intrabank: 'Intra-bank Transfer',
  swift: 'SWIFT / Forex', tdr: 'TDR/STDR', rd: 'Recurring Deposit', fastag: 'FASTag',
  bill_payment: 'Bill Payment', card: 'Card', atm: 'ATM', mandate: 'E-Mandate',
  prepaid_card: 'Prepaid Card', insurance_premium: 'Insurance Premium', mcash: 'mCash',
  donation: 'Donation', other: 'Transaction',
};

const modeKey = (mode) => (mode ? mode.toUpperCase() : 'TXN');
const modeLabel = (mode) => MODE_LABELS[mode] || 'Transaction';

function confirmationOf(denies) {
  if (denies === true) return { code: 'CUSTOMER_DENIES_TRANSACTION', label: 'Customer denies performing transaction' };
  if (denies === false) return { code: 'CUSTOMER_ACKNOWLEDGES_TRANSACTION', label: 'Customer acknowledges the transaction' };
  return { code: 'NOT_STATED', label: 'Not stated by customer' };
}

function classify({ txn, ctx, config }) {
  const intent = ctx?.intent || 'NONE';
  const reason = ctx?.reason || 'NONE';
  const mode = txn?.txn_mode || null;
  const base = {
    intent,
    reason,
    customer_confirmation: confirmationOf(ctx?.customer_denies_transaction ?? null),
    customer_summary: ctx?.summary || null,
  };

  if (intent === 'NONE' || intent === 'INFORMATION') {
    return { applicable: false, ...base, category: null, category_label: null, complaint_type: null, priority: null, escalation_required: false, escalation_reasons: [] };
  }

  if (intent === 'STATUS_ENQUIRY') {
    return { applicable: true, ...base, category: 'STATUS_ENQUIRY', category_label: 'Status Enquiry', complaint_type: 'STATUS_ENQUIRY', priority: 'LOW', escalation_required: false, escalation_reasons: [] };
  }

  let category; let label; let type; let priority = 'MEDIUM';
  const escalation = [];
  const failed = txn?.txn_status === 'FAILED';

  switch (reason) {
    case 'UNAUTHORISED_TRANSACTION':
      category = `${modeKey(mode)}_DISPUTE`; label = `${modeLabel(mode)} Dispute`;
      type = 'FRAUDULENT_DEBIT'; priority = 'HIGH';
      escalation.push('Customer reports an unauthorised transaction');
      break;
    case 'FAILED_BUT_DEBITED':
      category = 'FAILED_TRANSACTION'; label = 'Failed Transaction'; type = 'FAILED_TXN_AMOUNT_DEBITED';
      break;
    case 'WRONG_BENEFICIARY':
      category = 'WRONG_TRANSFER'; label = 'Transfer to Wrong Beneficiary'; type = 'WRONG_BENEFICIARY_CREDIT';
      break;
    case 'DUPLICATE_DEBIT':
      category = 'DUPLICATE_DEBIT'; label = 'Duplicate Debit'; type = 'DUPLICATE_DEBIT';
      break;
    case 'AMOUNT_MISMATCH':
      category = 'AMOUNT_MISMATCH'; label = 'Amount Mismatch'; type = 'INCORRECT_DEBIT_AMOUNT';
      break;
    case 'CREDIT_NOT_RECEIVED_BY_BENEFICIARY':
      category = `${modeKey(mode)}_DISPUTE`; label = `${modeLabel(mode)} Dispute`; type = 'CREDIT_NOT_RECEIVED';
      break;
    case 'REFUND_NOT_RECEIVED':
      category = 'REFUND_NOT_RECEIVED'; label = 'Refund Not Received'; type = 'REFUND_PENDING';
      break;
    case 'GOODS_SERVICE_NOT_RECEIVED':
      category = 'MERCHANT_DISPUTE'; label = 'Merchant Dispute'; type = 'GOODS_SERVICE_NOT_RECEIVED';
      break;
    default:
      if (failed) { category = 'FAILED_TRANSACTION'; label = 'Failed Transaction'; type = 'FAILED_TXN_AMOUNT_DEBITED'; }
      else { category = `${modeKey(mode)}_DISPUTE`; label = `${modeLabel(mode)} Dispute`; type = 'GENERAL_DISPUTE'; }
  }

  if (typeof txn?.amount === 'number' && txn.amount >= config.escalationAmountThreshold) {
    escalation.push(`Amount at or above escalation threshold (${config.escalationAmountThreshold})`);
    if (priority !== 'HIGH') priority = 'HIGH';
  }

  return {
    applicable: true, ...base, category, category_label: label, complaint_type: type, priority,
    escalation_required: escalation.length > 0, escalation_reasons: escalation,
  };
}

/** Messages the bot should send the customer immediately, independent of the complaint API. */
function advisoriesFor({ complaint, otpPresent, config }) {
  const out = [];
  if (otpPresent) {
    out.push({ code: 'OTP_SHARED', text: 'Please never share an OTP with anyone, including bank staff or this chat. If you shared it with someone, block your account/card immediately.' });
  }
  if (complaint?.complaint_type === 'FRAUDULENT_DEBIT') {
    out.push({ code: 'BLOCK_CHANNEL', text: `To stop further misuse, block your account/card/UPI now by calling ${config.bankHelpline}.` });
    out.push({ code: 'CYBER_HELPLINE', text: 'Report the fraud on the national cyber-crime helpline 1930 or at cybercrime.gov.in. Reporting quickly improves the chances of recovery.' });
  }
  return out;
}

module.exports = { classify, advisoriesFor, MODE_LABELS };
