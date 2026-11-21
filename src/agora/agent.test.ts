import assert from 'node:assert/strict';
import test from 'node:test';

Object.assign(process.env, {
  AGORA_APP_ID: 'app',
  AGORA_APP_CERTIFICATE: 'cert',
  AGORA_CUSTOMER_ID: 'id',
  AGORA_CUSTOMER_SECRET: 'secret',
  LLM_API_KEY: 'llm',
  MURF_API_KEY: 'murf',
  WEBHOOK_SECRET: 'x'.repeat(16),
  PUBLIC_BASE_URL: 'https://example.test',
});

test('join body wires Murf TTS and short-turn prompt', async () => {
  const { buildJoinBody, startAgentInput } = await import('./agent.js');
  const body = buildJoinBody(startAgentInput.parse({ channel: 'c1' }), 'tok');
  const { tts, llm } = body.properties;
  assert.equal(tts.vendor, 'murf');
  assert.equal(tts.params.base_url, 'wss://global.api.murf.ai/v1/speech/stream-input');
  assert.equal(tts.params.rate, -6);
  assert.equal(tts.params.sample_rate, 24000);
  assert.match(llm.system_messages[0].content, /1 or 2 short sentences/);
  assert.deepEqual(body.properties.remote_rtc_uids, ['1002']);
  assert.equal(body.properties.advanced_features.enable_tools, true);
  assert.equal(llm.template_variables.call_id, 'c1');
  assert.equal(llm.tools.length, 4);
  for (const t of llm.tools) assert.match(t.function.name, /^[a-zA-Z][a-zA-Z0-9]{0,63}$/); // Agora rejects underscores
  assert.equal(llm.tools[0].server.url, 'https://example.test/webhooks/verify-patient');
  assert.equal((llm.tools[0].server.body as Record<string, unknown>).birth_month, '{{args.birth_month}}');
});
