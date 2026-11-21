import type { Db } from './db.js';

const TABLES = ['patients', 'patient_medications', 'calls', 'tool_results', 'medication_logs', 'triage_logs', 'alerts', 'verify_failures'];

export const MIGRATIONS: { id: string; sql: string }[] = [
  {
    id: '001_init',
    sql: `
CREATE TABLE patients(
  id text PRIMARY KEY,
  first_name text NOT NULL,
  last_name text NOT NULL DEFAULT '',
  birth_date date NOT NULL,
  phone text NOT NULL DEFAULT '',
  language text NOT NULL DEFAULT 'en-US',
  discharge_date date,
  procedure_name text NOT NULL DEFAULT '',
  emergency_contact_name text NOT NULL DEFAULT '',
  emergency_contact_phone text NOT NULL DEFAULT '',
  consent_ai_call boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE patient_medications(
  id bigserial PRIMARY KEY,
  patient_id text NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  name text NOT NULL,
  dose text NOT NULL DEFAULT '',
  schedule text NOT NULL DEFAULT '',
  position int NOT NULL DEFAULT 0
);
CREATE TABLE calls(
  call_id text PRIMARY KEY,
  patient_id text NOT NULL REFERENCES patients(id),
  verified boolean NOT NULL DEFAULT false,
  failed_attempts int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE tool_results(
  tool_call_id text PRIMARY KEY,
  call_id text NOT NULL,
  tool text NOT NULL,
  response text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE medication_logs(
  call_id text PRIMARY KEY,
  picked_up boolean NOT NULL,
  dose_taken boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE triage_logs(
  call_id text PRIMARY KEY,
  fever boolean NOT NULL,
  swelling boolean NOT NULL,
  pain_score int NOT NULL,
  red_flag boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE alerts(
  id bigserial PRIMARY KEY,
  call_id text NOT NULL,
  patient_id text NOT NULL,
  reason text NOT NULL,
  details text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(call_id, reason)
);
CREATE TABLE verify_failures(
  id bigserial PRIMARY KEY,
  patient_id text NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX verify_failures_patient_at ON verify_failures(patient_id, at);
${TABLES.map((t) => `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`).join('\n')}
-- RLS with no policies: Supabase's public API (anon/authenticated keys) can read nothing here.
-- This server connects as the database owner, which bypasses RLS.
`,
  },
];

/** Applies pending migrations once, in order. Safe to run from several instances at the same time. */
export async function migrate(db: Db) {
  await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  for (const m of MIGRATIONS) {
    await db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(727274)');
      if ((await tx.query('SELECT 1 FROM schema_migrations WHERE id=$1', [m.id])).length) return;
      await tx.exec(m.sql);
      await tx.query('INSERT INTO schema_migrations(id) VALUES ($1)', [m.id]);
    });
  }
  await db.exec('ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY');
}
