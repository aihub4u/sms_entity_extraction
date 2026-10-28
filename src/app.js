'use strict';

const crypto = require('crypto');
const express = require('express');
const { validate, extractSchema, finalizeSchema, submitSchema } = require('./validation');
const { buildResponse } = require('./services/processor');
const { todayIn } = require('./services/normalize');

/**
 * @param {object} deps
 * @param {object} deps.config
 * @param {Function} deps.extract  async ({smsText,image,customerMessage,today}) => {data, model, usage}
 * @param {Function} [deps.fetchImpl] used to forward to SBI's complaint API
 */
function createApp({ config, extract, fetchImpl = fetch }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: `${config.maxBodyMb}mb` }));

  // Request id + access log (never logs SMS content or customer text)
  app.use((req, res, next) => {
    req.id = req.get('x-request-id') || crypto.randomUUID();
    res.set('x-request-id', req.id);
    const start = Date.now();
    res.on('finish', () => {
      console.log(JSON.stringify({ ts: new Date().toISOString(), id: req.id, method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - start }));
    });
    next();
  });

  app.get('/health', (req, res) => res.json({ ok: true, model: config.openaiModel, llm_configured: Boolean(config.openaiApiKey) }));

  // API-key auth for everything under /v1
  app.use('/v1', (req, res, next) => {
    if (!config.apiKey) return next();
    const given = req.get('x-api-key') || '';
    const a = Buffer.from(given);
    const b = Buffer.from(config.apiKey);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
    return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing or invalid x-api-key' } });
  });

  /**
   * POST /v1/transactions/extract
   * SMS text and/or screenshot (+ optional customer message) -> structured
   * transaction, complaint classification, missing fields, SBI payloads.
   */
  app.post('/v1/transactions/extract', validate(extractSchema), async (req, res, next) => {
    try {
      const b = req.body;
      const today = todayIn(config.timeZone);
      const t0 = Date.now();
      const { data, model, usage } = await extract({ smsText: b.sms_text, image: b.image, customerMessage: b.customer_message, today });
      const result = buildResponse({
        extraction: data,
        smsText: b.sms_text,
        hasImage: Boolean(b.image),
        overrides: b.overrides,
        twixRequestId: b.twix_request_id,
        mobileNumber: b.mobile_number,
        config,
        today,
        meta: { request_id: req.id, model, llm_latency_ms: Date.now() - t0, usage },
      });
      res.json(result);
    } catch (err) { next(err); }
  });

  /**
   * POST /v1/complaints/finalize
   * Stateless follow-up: send back the `extraction` from /extract plus the
   * values the bot collected from the customer (overrides). No LLM call.
   */
  app.post('/v1/complaints/finalize', validate(finalizeSchema), (req, res) => {
    const b = req.body;
    const today = todayIn(config.timeZone);
    res.json(buildResponse({
      extraction: b.extraction,
      smsText: b.sms_text,
      hasImage: false,
      overrides: b.overrides,
      twixRequestId: b.twix_request_id,
      mobileNumber: b.mobile_number,
      config,
      today,
      meta: { request_id: req.id, model: null, llm_latency_ms: 0 },
    }));
  });

  /**
   * POST /v1/complaints/submit
   * Forwards `sbi_request` to SBI's complaint API when SBI_COMPLAINT_API_URL
   * is configured; otherwise returns a mock acknowledgement for the POC.
   */
  app.post('/v1/complaints/submit', validate(submitSchema), async (req, res, next) => {
    try {
      if (!config.sbiComplaintApiUrl) {
        return res.json({
          mock: true,
          complaint_id: `MOCK${Date.now().toString().slice(-8)}`,
          status: 'REGISTERED',
          message: 'Mock acknowledgement. Set SBI_COMPLAINT_API_URL to forward to SBI.',
          forwarded_payload: req.body,
        });
      }
      const headers = { 'content-type': 'application/json' };
      if (config.sbiComplaintApiKey) headers.authorization = `Bearer ${config.sbiComplaintApiKey}`;
      const upstream = await fetchImpl(config.sbiComplaintApiUrl, { method: 'POST', headers, body: JSON.stringify(req.body), signal: AbortSignal.timeout(20000) });
      const text = await upstream.text();
      let body; try { body = JSON.parse(text); } catch { body = { raw: text }; }
      return res.status(upstream.ok ? 200 : 502).json({ mock: false, upstream_status: upstream.status, upstream_body: body });
    } catch (err) { next(err); }
  });

  app.use((req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: `${req.method} ${req.path} not found` } }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large' } });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Body is not valid JSON' } });
    const status = err.status || 500;
    console.error(JSON.stringify({ id: req.id, error: err.code || 'INTERNAL', message: err.message }));
    return res.status(status).json({ error: { code: err.code || 'INTERNAL_ERROR', message: status === 500 ? 'Internal error' : err.message, request_id: req.id } });
  });

  return app;
}

module.exports = { createApp };
