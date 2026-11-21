import { z } from 'zod';
import type { Store } from '../store/store.js';
import { escalateToNurse, logMedicationStatus, recordSymptomTriage, verifyPatient } from './handlers.js';

type Params = { type: 'object'; properties: Record<string, object>; required: string[]; additionalProperties: false };
interface Tool {
  name: string; // Agora: letters and digits only, no underscores
  path: string;
  description: string;
  schema: z.ZodTypeAny;
  params: Params; // JSON Schema shown to the LLM; keep in sync with `schema`
  handler: (s: Store, callId: string, args: any) => object;
}
function defineTool<S extends z.ZodTypeAny>(t: Omit<Tool, 'schema' | 'handler'> & { schema: S; handler: (s: Store, callId: string, a: z.output<S>) => object }): Tool {
  return t;
}

// Every param is required: Agora fails the call with UnresolvedTemplate if a templated arg is missing.
const obj = (properties: Record<string, object>): Params => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

export const tools: Tool[] = [
  defineTool({
    name: 'verifyPatient', path: 'verify-patient',
    description: 'Verify the patient identity from their birth month and day. Call this before discussing any medication or health detail.',
    schema: z.object({ birth_month: z.coerce.number().int().min(1).max(12), birth_day: z.coerce.number().int().min(1).max(31) }),
    params: obj({ birth_month: { type: 'integer', description: 'Birth month as a number, 1 to 12' }, birth_day: { type: 'integer', description: 'Day of the month, 1 to 31' } }),
    handler: verifyPatient,
  }),
  defineTool({
    name: 'logMedicationStatus', path: 'log-medication',
    description: 'Record whether the patient picked up their prescriptions and took today\'s dose.',
    schema: z.object({ prescriptions_picked_up: z.boolean(), dose_taken_today: z.boolean() }),
    params: obj({ prescriptions_picked_up: { type: 'boolean' }, dose_taken_today: { type: 'boolean' } }),
    handler: logMedicationStatus,
  }),
  defineTool({
    name: 'recordSymptomTriage', path: 'symptom-triage',
    description: 'Record the patient\'s red-flag symptom answers: fever, unusual swelling, and pain score.',
    schema: z.object({ fever: z.boolean(), unusual_swelling: z.boolean(), pain_score: z.coerce.number().int().min(0).max(10) }),
    params: obj({ fever: { type: 'boolean' }, unusual_swelling: { type: 'boolean' }, pain_score: { type: 'integer', description: 'Pain from 0 (none) to 10 (worst)' } }),
    handler: recordSymptomTriage,
  }),
  defineTool({
    name: 'escalateToNurse', path: 'escalate-to-nurse',
    description: 'Escalate to a nurse. Use for any red-flag symptom, any clinical question from the patient, or any emergency.',
    schema: z.object({ reason: z.enum(['red_flag_symptoms', 'clinical_question', 'emergency']), details: z.string().max(500) }),
    params: obj({
      reason: { type: 'string', enum: ['red_flag_symptoms', 'clinical_question', 'emergency'] },
      details: { type: 'string', description: 'One short sentence in the patient\'s own words. Never include a diagnosis.' },
    }),
    handler: escalateToNurse,
  }),
];

const envelope = z.object({ call_id: z.string().min(1), tool_call_id: z.string().min(1) }).passthrough();

/** Idempotent on tool_call_id: a replay returns the stored response and changes nothing. */
export function runTool(store: Store, tool: Tool, raw: unknown): { status: number; body: unknown; call_id?: string; args?: unknown; fresh?: boolean } {
  const env = envelope.safeParse(raw);
  if (!env.success) return { status: 400, body: { ok: false, error: 'invalid_request' } };
  const { call_id, tool_call_id, ...rest } = env.data;

  const prior = store.getResult(tool_call_id);
  if (prior) return { status: 200, body: JSON.parse(prior) };

  const args = tool.schema.safeParse(rest);
  if (!args.success) {
    return { status: 400, body: { ok: false, error: 'invalid_arguments', issues: args.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) } };
  }
  const body = store.transaction(() => {
    const r = tool.handler(store, call_id, args.data);
    store.saveResult(tool_call_id, call_id, tool.name, JSON.stringify(r));
    return r;
  });
  return { status: 200, body, call_id, args: args.data, fresh: true };
}

/** Tool definitions in Agora's `llm.tools` format: the engine POSTs the args to our webhook. */
export function agoraTools(baseUrl: string, secret: string) {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.params },
    server: {
      method: 'POST',
      url: `${baseUrl.replace(/\/$/, '')}/webhooks/${t.path}`,
      headers: { 'X-Webhook-Secret': secret },
      body: {
        call_id: '{{template_variables.call_id}}',
        tool_call_id: '{{tool_call_id}}',
        ...Object.fromEntries(Object.keys(t.params.properties).map((k) => [k, `{{args.${k}}}`])),
      },
      timeout_ms: 5000,
    },
  }));
}
