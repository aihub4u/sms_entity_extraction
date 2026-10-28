'use strict';

const { z } = require('zod');

const overridesSchema = z.object({
  txnNo: z.string().max(64).optional(),
  amount: z.union([z.number().nonnegative(), z.string().max(64)]).optional(),
  time: z.string().max(100).optional().describe('Customer answer as typed: a time, a date, or both'),
  merchant: z.string().max(120).optional(),
  account_card_det: z.string().max(32).optional(),
  txnType: z.string().max(32).optional(),
}).strict();

const imageSchema = z.object({
  url: z.string().url().optional(),
  base64: z.string().optional(),
  mime_type: z.enum(['image/jpeg', 'image/png', 'image/webp']).optional(),
}).refine((i) => Boolean(i.url) !== Boolean(i.base64), { message: 'image needs exactly one of url or base64' });

const common = {
  twix_request_id: z.string().min(1).max(64),
  mobile_number: z.string().min(10).max(15).refine((s) => [...s].every((c) => c >= '0' && c <= '9'), 'digits only'),
  customer_message: z.string().max(2000).optional(),
  overrides: overridesSchema.optional(),
};

const extractSchema = z.object({
  ...common,
  sms_text: z.string().min(5).max(2000).optional(),
  image: imageSchema.optional(),
}).refine((b) => b.sms_text || b.image, { message: 'Provide sms_text or image' });

const finalizeSchema = z.object({
  ...common,
  extraction: z.object({
    message_kind: z.string(),
    is_bank_message: z.boolean(),
    bank_name: z.string().nullable(),
    otp_present: z.boolean(),
    transaction: z.record(z.string(), z.any()),
    customer_context: z.object({
      intent: z.string(),
      reason: z.string(),
      customer_denies_transaction: z.boolean().nullable(),
      summary: z.string().nullable(),
    }),
    confidence: z.number(),
    extraction_notes: z.array(z.string()),
  }),
  sms_text: z.string().max(2000).optional(),
});

const submitSchema = z.object({
  twix_request_id: z.string().min(1),
  mobile_number: z.string().min(10),
  type: z.string().startsWith('JSON_COMPLAIN_REQ'),
}).passthrough();

function validate(schema) {
  return (req, res, next) => {
    const r = schema.safeParse(req.body ?? {});
    if (!r.success) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Invalid request body', details: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
      });
    }
    req.body = r.data;
    return next();
  };
}

module.exports = { validate, extractSchema, finalizeSchema, submitSchema };
