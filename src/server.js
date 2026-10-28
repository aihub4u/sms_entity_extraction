'use strict';

const config = require('./config');
const { createApp } = require('./app');
const { createOpenAIExtractor } = require('./llm/openaiExtractor');
const { createOpenAINormalizer } = require('./llm/openaiNormalizer');

if (!config.openaiApiKey) {
  console.error('OPENAI_API_KEY is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const app = createApp({
  config,
  extract: createOpenAIExtractor(config),
  llmNormalize: createOpenAINormalizer(config),
});
app.listen(config.port, () => {
  console.log(`SBI transaction API listening on :${config.port} (model ${config.openaiModel})`);
});
