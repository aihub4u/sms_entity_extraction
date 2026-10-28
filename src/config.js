'use strict';

require('dotenv').config();

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

const config = {
  port: num(process.env.PORT, 3000),
  apiKey: process.env.API_KEY || null, // if set, clients must send x-api-key

  openaiApiKey: process.env.OPENAI_API_KEY || null,
  openaiBaseUrl: process.env.OPENAI_BASE_URL || null, // e.g. Azure OpenAI / proxy
  openaiModel: process.env.OPENAI_MODEL || 'gpt-5.4-mini',
  openaiTemperature: process.env.OPENAI_TEMPERATURE === undefined || process.env.OPENAI_TEMPERATURE === '' ? null : Number(process.env.OPENAI_TEMPERATURE),
  openaiReasoningEffort: process.env.OPENAI_REASONING_EFFORT || null, // minimal | low | medium | high
  openaiTimeoutMs: num(process.env.OPENAI_TIMEOUT_MS, 30000),

  timeZone: process.env.TZ_NAME || 'Asia/Kolkata',
  requiredFields: (process.env.REQUIRED_FIELDS || 'txnNo,amount,date,time,account_card_det,txnType')
    .split(',').map((s) => s.trim()).filter(Boolean),
  escalationAmountThreshold: num(process.env.ESCALATION_AMOUNT_THRESHOLD, 100000),
  maxTxnAgeDays: num(process.env.MAX_TXN_AGE_DAYS, 365),
  bankHelpline: process.env.BANK_HELPLINE || '1800111109',

  sbiComplaintApiUrl: process.env.SBI_COMPLAINT_API_URL || null, // unset => mock submit
  sbiComplaintApiKey: process.env.SBI_COMPLAINT_API_KEY || null,
  maxBodyMb: num(process.env.MAX_BODY_MB, 8),
};

module.exports = config;
