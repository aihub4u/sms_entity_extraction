'use strict';

/**
 * Anti-hallucination check: every identifier the LLM returns must literally
 * appear in the SMS text (ignoring case, spaces and thousands separators).
 * Values that don't appear are dropped so the bot asks the customer instead
 * of sending a made-up reference to the bank.
 *
 * Only runs for text input; screenshots are read by the model directly.
 */

const compact = (s) => String(s).toLowerCase().split('').filter((c) => c !== ' ' && c !== ',' && c !== '\n' && c !== '\t').join('');

const IDENTIFIER_FIELDS = [
  'txn_ref_no', 'debit_account_masked', 'credit_account_masked',
  'deposit_ref_no', 'bill_no', 'beneficiary_name',
];

function amountAppears(amount, haystack) {
  // 10000 -> "10000"; 106.5 -> "106.5"; also accept the 2-dp form.
  const candidates = new Set([String(amount), amount.toFixed(2)]);
  if (Number.isInteger(amount)) candidates.add(String(amount));
  return [...candidates].some((c) => haystack.includes(c));
}

function groundTransaction(txn, sourceText) {
  const result = { checked: true, dropped: [], verified: [] };
  const out = { ...txn };
  const hay = compact(sourceText);

  for (const field of IDENTIFIER_FIELDS) {
    const v = out[field];
    if (v === null || v === undefined || v === '') continue;
    if (hay.includes(compact(v))) result.verified.push(field);
    else {
      result.dropped.push({ field, value: v });
      out[field] = null;
    }
  }

  if (typeof out.amount === 'number') {
    if (amountAppears(out.amount, hay)) result.verified.push('amount');
    else {
      result.dropped.push({ field: 'amount', value: out.amount });
      out.amount = null;
    }
  }

  return { transaction: out, grounding: result };
}

module.exports = { groundTransaction };
