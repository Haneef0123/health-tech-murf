import 'dotenv/config';
import { z } from 'zod';

// Each group is parsed lazily so the Murf smoke check works before Agora creds exist.
const murfSchema = z.object({
  MURF_API_KEY: z.string().min(1),
  MURF_WS_URL: z.string().default('wss://global.api.murf.ai/v1/speech/stream-input'),
  MURF_MODEL: z.string().default('falcon-2.1'),
  MURF_VOICE_ID: z.string().default('Gordon'),
  MURF_LOCALE: z.string().default('en-US'),
  MURF_RATE: z.coerce.number().default(-6),
  MURF_PITCH: z.coerce.number().default(0),
  MURF_SAMPLE_RATE: z.coerce.number().default(24000),
});

const agoraSchema = z.object({
  AGORA_APP_ID: z.string().min(1),
  AGORA_APP_CERTIFICATE: z.string().min(1),
  AGORA_CUSTOMER_ID: z.string().min(1),
  AGORA_CUSTOMER_SECRET: z.string().min(1),
  LLM_URL: z.string().default('https://api.openai.com/v1/chat/completions'),
  LLM_API_KEY: z.string().min(1),
  LLM_MODEL: z.string().default('gpt-4o-mini'),
  // Extra request params merged into the LLM call, as a JSON object. DeepSeek needs {"thinking":{"type":"disabled"}}
  // or its reasoning text is spoken aloud.
  LLM_EXTRA_PARAMS: z.string().default('{}').transform((s, ctx) => {
    try {
      const v = JSON.parse(s);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch { /* falls through to the issue below */ }
    ctx.addIssue({ code: 'custom', message: 'must be a JSON object' });
    return z.NEVER;
  }),
});

const serverSchema = z.object({
  PORT: z.coerce.number().default(3000),
  // Postgres connection string (Supabase "Session pooler" URI). When unset, a local PGlite database is used at DB_PATH.
  DATABASE_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().regex(/^postgres(ql)?:\/\//, 'must start with postgres:// or postgresql://').optional()),
  DB_PATH: z.string().default('data/pglite'),
  NURSE_ALERT_LOG: z.string().default('data/nurse-alerts.log'),
});

// Agora calls our tool webhooks from the internet, so the base URL must be public HTTPS (e.g. an ngrok URL).
const secretSchema = z.object({ WEBHOOK_SECRET: z.string().min(16) });
const webhookSchema = secretSchema.extend({
  PUBLIC_BASE_URL: z.string().regex(/^https:\/\//, 'must be a public https:// URL'),
});

// Optional login for the test page and /api (see src/auth.ts).
const authSchema = z.object({
  BASIC_AUTH_USER: z.string().default('admin'),
  BASIC_AUTH_PASS: z.string().optional(),
});

function load<T extends z.ZodTypeAny>(schema: T, env: NodeJS.ProcessEnv = process.env): z.output<T> {
  const r = schema.safeParse(env);
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment (see .env.example): ${issues}`);
  }
  return r.data;
}

export const murfConfig = () => load(murfSchema);
export const agoraConfig = () => load(agoraSchema);
export const serverConfig = () => load(serverSchema);
export const authConfig = () => load(authSchema);
// Render sets RENDER_EXTERNAL_URL to the service's public https URL, so no manual PUBLIC_BASE_URL is needed there.
export const webhookConfig = () =>
  load(webhookSchema, { ...process.env, PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL });
export const webhookSecret = () => load(secretSchema).WEBHOOK_SECRET; // auth only: no public URL needed
