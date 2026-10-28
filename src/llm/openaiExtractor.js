'use strict';

const OpenAI = require('openai');
const { extractionSchema } = require('./schema');
const { buildSystemPrompt, buildUserContent } = require('./prompt');

class ExtractionError extends Error {
  constructor(message, { status = 502, code = 'EXTRACTION_FAILED' } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Creates an extractor function: (input) => Promise<{ data, model, usage }>.
 * Injectable so tests and future providers can swap it out.
 */
function createOpenAIExtractor(config) {
  const client = new OpenAI({
    apiKey: config.openaiApiKey,
    baseURL: config.openaiBaseUrl || undefined,
    timeout: config.openaiTimeoutMs,
    maxRetries: 2,
  });

  return async function extract({ smsText, image, customerMessage, today }) {
    const body = {
      model: config.openaiModel,
      messages: [
        { role: 'system', content: buildSystemPrompt({ today }) },
        { role: 'user', content: buildUserContent({ smsText, image, customerMessage }) },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'bank_txn_extraction', strict: true, schema: extractionSchema },
      },
    };
    // Reasoning models reject `temperature`; only send what is configured.
    if (config.openaiTemperature !== null) body.temperature = config.openaiTemperature;
    if (config.openaiReasoningEffort) body.reasoning_effort = config.openaiReasoningEffort;

    let completion;
    try {
      completion = await client.chat.completions.create(body);
    } catch (err) {
      const status = err.status === 400 ? 422 : 502;
      throw new ExtractionError(`LLM request failed: ${err.message}`, { status, code: 'LLM_ERROR' });
    }

    const msg = completion.choices?.[0]?.message;
    if (!msg) throw new ExtractionError('LLM returned no message');
    if (msg.refusal) throw new ExtractionError(`LLM refused: ${msg.refusal}`, { status: 422, code: 'LLM_REFUSAL' });

    let data;
    try {
      data = JSON.parse(msg.content);
    } catch {
      throw new ExtractionError('LLM returned invalid JSON');
    }
    return { data, model: completion.model, usage: completion.usage || null };
  };
}

module.exports = { createOpenAIExtractor, ExtractionError };
