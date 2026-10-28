'use strict';

/**
 * JSON schema the LLM must return (OpenAI Structured Outputs, strict mode).
 * Strict mode requires every property to be listed in `required`; optional
 * values are expressed as nullable types instead.
 *
 * Nothing here is SBI-template-specific: the model reads any bank SMS
 * (or screenshot) and fills this shape, so newly whitelisted templates
 * work without code changes.
 */

const nullable = (type, extra = {}) => ({ type: [type, 'null'], ...extra });
const nullableEnum = (values) => ({ type: ['string', 'null'], enum: [...values, null] });

const TXN_MODES = [
  'upi', 'imps', 'neft', 'rtgs', 'intrabank', 'swift', 'tdr', 'rd',
  'fastag', 'bill_payment', 'card', 'atm', 'mandate', 'prepaid_card',
  'insurance_premium', 'mcash', 'donation', 'other',
];

const REF_TYPES = [
  'UPI_RRN', 'IMPS_REF', 'NEFT_UTR', 'RTGS_UTR', 'INTRABANK_REF', 'SWIFT_REF',
  'TDR_NO', 'BILL_NO', 'MANDATE_ID', 'REQUEST_ID', 'CARD_AUTH_CODE', 'OTHER',
];

const MESSAGE_KINDS = [
  'TRANSACTION_ALERT', // debit / credit / failure alert for a completed or attempted txn
  'OTP',               // one-time-password message
  'ACCOUNT_INFO',      // balance, statement, deposit creation notice without debit dispute value
  'PROMOTIONAL',
  'NOT_BANK_SMS',
  'UNREADABLE',
];

const INTENTS = ['RAISE_DISPUTE', 'REFUND_REQUEST', 'STATUS_ENQUIRY', 'INFORMATION', 'NONE'];

const REASONS = [
  'UNAUTHORISED_TRANSACTION',
  'FAILED_BUT_DEBITED',
  'WRONG_BENEFICIARY',
  'DUPLICATE_DEBIT',
  'AMOUNT_MISMATCH',
  'GOODS_SERVICE_NOT_RECEIVED',
  'REFUND_NOT_RECEIVED',
  'CREDIT_NOT_RECEIVED_BY_BENEFICIARY',
  'OTHER',
  'NONE',
];

const extractionSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'message_kind', 'is_bank_message', 'bank_name', 'otp_present',
    'transaction', 'customer_context', 'confidence', 'extraction_notes',
  ],
  properties: {
    message_kind: { type: 'string', enum: MESSAGE_KINDS },
    is_bank_message: { type: 'boolean' },
    bank_name: nullable('string', { description: 'Bank that sent the SMS, e.g. "SBI". Null if unclear.' }),
    otp_present: { type: 'boolean', description: 'True if the text contains a one-time password. Never return the OTP itself anywhere.' },
    transaction: {
      type: 'object',
      additionalProperties: false,
      required: [
        'txn_ref_no', 'ref_type', 'amount', 'currency', 'date_iso', 'date_as_written',
        'time_24h', 'dr_cr', 'txn_status', 'txn_mode', 'txn_description',
        'debit_account_masked', 'credit_account_masked', 'beneficiary_name',
        'merchant', 'deposit_ref_no', 'bill_no', 'channel', 'failure_reason',
      ],
      properties: {
        txn_ref_no: nullable('string', { description: 'Primary transaction reference / UTR / RRN exactly as written, no labels.' }),
        ref_type: nullableEnum(REF_TYPES),
        amount: nullable('number', { description: 'Numeric amount without separators, e.g. 10000.00' }),
        currency: nullable('string', { description: 'ISO 4217 code: INR for Rs/₹/INR, USD, etc.' }),
        date_iso: nullable('string', { description: 'Transaction date as YYYY-MM-DD.' }),
        date_as_written: nullable('string', { description: 'Date exactly as it appears in the text.' }),
        time_24h: nullable('string', { description: 'HH:MM only if a time is explicitly written; otherwise null.' }),
        dr_cr: nullableEnum(['DR', 'CR']),
        txn_status: nullableEnum(['SUCCESS', 'FAILED', 'PENDING', 'INITIATED']),
        txn_mode: nullableEnum(TXN_MODES),
        txn_description: nullable('string', { description: 'Short label, e.g. "IMPS Transfer", "FASTag Bill Payment".' }),
        debit_account_masked: nullable('string', { description: 'Customer/debited account or card exactly as masked in text, e.g. "XXXXXXXX4666", "x6047".' }),
        credit_account_masked: nullable('string', { description: 'Beneficiary/credited account as masked in text.' }),
        beneficiary_name: nullable('string'),
        merchant: nullable('string', { description: 'Merchant/biller/payee name for payments, e.g. "ICICI Bank FASTag". Null for plain transfers unless a payee name exists.' }),
        deposit_ref_no: nullable('string', { description: 'TDR/STDR/RD/FD number if present.' }),
        bill_no: nullable('string', { description: 'Bill / recharge / FASTag bill number if present.' }),
        channel: nullable('string', { description: 'App or channel, e.g. "YONO SBI", "Yono Lite SBI", "UPI", "Anywhere Corporate".' }),
        failure_reason: nullable('string'),
      },
    },
    customer_context: {
      type: 'object',
      additionalProperties: false,
      required: ['intent', 'reason', 'customer_denies_transaction', 'summary'],
      properties: {
        intent: { type: 'string', enum: INTENTS },
        reason: { type: 'string', enum: REASONS },
        customer_denies_transaction: { type: ['boolean', 'null'], description: 'True if the customer says they did not do / authorise it. Null if not stated.' },
        summary: nullable('string', { description: 'One-line neutral summary of what the customer says. Null if no customer message.' }),
      },
    },
    confidence: { type: 'number', description: '0-1 overall confidence in the transaction extraction.' },
    extraction_notes: {
      type: 'array',
      items: { type: 'string' },
      description: 'Ambiguities or assumptions made, e.g. "date assumed DD-MM-YY". Empty if none.',
    },
  },
};

module.exports = { extractionSchema, TXN_MODES, REF_TYPES, MESSAGE_KINDS, INTENTS, REASONS };
