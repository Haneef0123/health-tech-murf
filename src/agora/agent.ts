import { z } from 'zod';
import { agoraConfig, murfConfig, webhookConfig } from '../config.js';
import { getStore } from '../store/store.js';
import { agoraTools } from '../tools/registry.js';
import { GREETING, SYSTEM_PROMPT } from './prompt.js';
import { buildRtcToken } from './token.js';

const BASE = 'https://api.agora.io/api/conversational-ai-agent/v2/projects';

export const startAgentInput = z.object({
  channel: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
  agentUid: z.number().int().positive().default(1001),
  userUid: z.number().int().positive().default(1002),
  patientId: z.string().default('demo-001'),
});
export type StartAgentInput = z.input<typeof startAgentInput>;

/** Pure: builds the /join body. Murf param names follow Agora's Murf TTS page (voiceId, sample_rate, ...). */
export function buildJoinBody(i: z.output<typeof startAgentInput>, agentToken: string) {
  const a = agoraConfig();
  const m = murfConfig();
  const w = webhookConfig();
  return {
    name: `checkin-${i.channel}-${Date.now()}`, // must be unique per agent
    properties: {
      channel: i.channel,
      token: agentToken,
      agent_rtc_uid: String(i.agentUid),
      remote_rtc_uids: [String(i.userUid)],
      idle_timeout: 120,
      asr: { language: 'en-US' },
      advanced_features: { enable_tools: true },
      llm: {
        template_variables: { call_id: i.channel }, // webhooks receive this to find the call
        tools: agoraTools(w.PUBLIC_BASE_URL, w.WEBHOOK_SECRET),
        url: a.LLM_URL,
        api_key: a.LLM_API_KEY,
        system_messages: [{ role: 'system', content: SYSTEM_PROMPT }],
        greeting_message: GREETING,
        failure_message: 'Sorry, one moment please.',
        max_history: 32,
        params: { model: a.LLM_MODEL },
      },
      tts: {
        vendor: 'murf',
        params: {
          api_key: m.MURF_API_KEY,
          base_url: m.MURF_WS_URL,
          model: m.MURF_MODEL,
          voiceId: m.MURF_VOICE_ID,
          locale: m.MURF_LOCALE,
          rate: m.MURF_RATE,
          pitch: m.MURF_PITCH,
          sample_rate: m.MURF_SAMPLE_RATE,
        },
      },
    },
  };
}

async function agoraPost(path: string, body?: unknown): Promise<unknown> {
  const { AGORA_APP_ID, AGORA_CUSTOMER_ID, AGORA_CUSTOMER_SECRET } = agoraConfig();
  const basic = Buffer.from(`${AGORA_CUSTOMER_ID}:${AGORA_CUSTOMER_SECRET}`).toString('base64');
  const res = await fetch(`${BASE}/${AGORA_APP_ID}${path}`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Agora ${path} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

export async function startAgent(input: StartAgentInput) {
  const i = startAgentInput.parse(input);
  getStore().createCall(i.channel, i.patientId); // register before the agent can call any tool
  const body = buildJoinBody(i, buildRtcToken(i.channel, i.agentUid));
  const res = (await agoraPost('/join', body)) as { agent_id: string; status: string };
  return {
    agentId: res.agent_id,
    status: res.status,
    appId: agoraConfig().AGORA_APP_ID,
    channel: i.channel,
    agentUid: i.agentUid,
    userUid: i.userUid,
    userToken: buildRtcToken(i.channel, i.userUid),
  };
}

export async function stopAgent(agentId: string) {
  await agoraPost(`/agents/${encodeURIComponent(agentId)}/leave`);
}
