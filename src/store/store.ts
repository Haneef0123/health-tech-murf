import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { serverConfig } from '../config.js';
import { publish } from '../events.js';
import type { Medication, Patient, PatientInput } from '../patients/schema.js';
import { type Db, type OpenDb, openDb } from './db.js';
import { migrate } from './schema.js';

export interface CallRow { call_id: string; patient_id: string; verified: boolean; failed_attempts: number }

// Fictional demo patient (not real PHI), seeded only into an empty database.
const DEMO: PatientInput & { id: string } = {
  id: 'demo-001', first_name: 'Alex', last_name: 'Demo', birth_date: '1990-03-14', phone: '', language: 'en-US',
  discharge_date: null, procedure_name: 'knee surgery', emergency_contact_name: '', emergency_contact_phone: '', consent_ai_call: true,
  medications: [
    { name: 'Amoxicillin', dose: '500 milligrams', schedule: 'three times a day' },
    { name: 'Ibuprofen', dose: '400 milligrams', schedule: 'as needed for pain' },
  ],
};

const PATIENT_COLS = `id, first_name, last_name, birth_date::text AS birth_date, phone, language, discharge_date::text AS discharge_date,
  procedure_name, emergency_contact_name, emergency_contact_phone, consent_ai_call, active, created_at::text AS created_at`;

// Plain functions over a Db (not methods) so transactions can reuse them without the store referring to itself.
async function loadPatients(db: Db, where: string, params: unknown[] = []): Promise<Patient[]> {
  const rows = await db.query(`SELECT ${PATIENT_COLS} FROM patients ${where} ORDER BY created_at, id`, params);
  if (!rows.length) return [];
  const meds = await db.query('SELECT patient_id, name, dose, schedule FROM patient_medications ORDER BY patient_id, position, id');
  return rows.map((r) => ({
    ...(r as any),
    medications: meds.filter((m) => m.patient_id === r.id).map(({ name, dose, schedule }) => ({ name, dose, schedule })),
  }));
}
const loadPatient = async (db: Db, id: string) => (await loadPatients(db, 'WHERE id=$1', [id]))[0];

async function writeMeds(db: Db, patientId: string, meds: Medication[]) {
  await db.query('DELETE FROM patient_medications WHERE patient_id=$1', [patientId]);
  for (const [i, m] of meds.entries()) {
    await db.query('INSERT INTO patient_medications(patient_id,name,dose,schedule,position) VALUES ($1,$2,$3,$4,$5)', [patientId, m.name, m.dose, m.schedule, i]);
  }
}

const patientParams = (i: PatientInput) =>
  [i.first_name, i.last_name, i.birth_date, i.phone, i.language, i.discharge_date, i.procedure_name, i.emergency_contact_name, i.emergency_contact_phone, i.consent_ai_call];

function insertPatient(db: Db, input: PatientInput, id: string): Promise<Patient> {
  return db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO patients(id,first_name,last_name,birth_date,phone,language,discharge_date,procedure_name,emergency_contact_name,emergency_contact_phone,consent_ai_call)
       VALUES ($1,$2,$3,$4::date,$5,$6,$7::date,$8,$9,$10,$11)`,
      [id, ...patientParams(input)],
    );
    await writeMeds(tx, id, input.medications);
    return (await loadPatient(tx, id))!;
  });
}

function makeCore(db: Db, alertLogPath: string) {
  const one = async <T>(sql: string, ...p: unknown[]) => (await db.query<T>(sql, p))[0];

  return {
    // ---- patient profiles ----
    getPatient: (id: string) => loadPatient(db, id),
    listPatients: (includeInactive = false) => loadPatients(db, includeInactive ? '' : 'WHERE active'),
    createPatient: (input: PatientInput, id: string = randomUUID()) => insertPatient(db, input, id),
    updatePatient(id: string, input: PatientInput): Promise<Patient | undefined> {
      return db.transaction(async (tx) => {
        const r = await tx.query(
          `UPDATE patients SET first_name=$2,last_name=$3,birth_date=$4::date,phone=$5,language=$6,discharge_date=$7::date,procedure_name=$8,
             emergency_contact_name=$9,emergency_contact_phone=$10,consent_ai_call=$11,updated_at=now() WHERE id=$1 RETURNING id`,
          [id, ...patientParams(input)],
        );
        if (!r.length) return undefined;
        await writeMeds(tx, id, input.medications);
        return loadPatient(tx, id);
      });
    },
    /** Soft delete: calls and alerts keep pointing at the patient. */
    async deactivatePatient(id: string): Promise<boolean> {
      return (await db.query('UPDATE patients SET active=false, updated_at=now() WHERE id=$1 RETURNING id', [id])).length > 0;
    },
    async seedDemoIfEmpty() {
      if (!(await one('SELECT 1 AS x FROM patients LIMIT 1'))) await insertPatient(db, DEMO, DEMO.id);
    },

    // ---- calls and identity checks ----
    /** Starting a call under an existing id resets its verification state. */
    async createCall(callId: string, patientId: string) {
      if (!(await loadPatient(db, patientId))) throw new Error(`unknown patient ${patientId}`);
      await db.query(
        `INSERT INTO calls(call_id,patient_id) VALUES ($1,$2)
         ON CONFLICT (call_id) DO UPDATE SET patient_id=EXCLUDED.patient_id, verified=false, failed_attempts=0, created_at=now()`,
        [callId, patientId],
      );
    },
    getCall: (callId: string) => one<CallRow>('SELECT call_id, patient_id, verified, failed_attempts FROM calls WHERE call_id=$1', callId),
    markVerified: async (callId: string) => void (await db.query('UPDATE calls SET verified=true WHERE call_id=$1', [callId])),
    async addFailedAttempt(callId: string): Promise<number> {
      return (await one<{ failed_attempts: number }>('UPDATE calls SET failed_attempts=failed_attempts+1 WHERE call_id=$1 RETURNING failed_attempts', callId))!.failed_attempts;
    },
    recordVerifyFailure: async (patientId: string) => void (await db.query('INSERT INTO verify_failures(patient_id) VALUES ($1)', [patientId])),
    async recentVerifyFailures(patientId: string, minutes: number): Promise<number> {
      return (await one<{ n: number }>(`SELECT count(*)::int AS n FROM verify_failures WHERE patient_id=$1 AND at > now() - ($2::int * interval '1 minute')`, patientId, minutes))!.n;
    },

    // ---- call data ----
    saveMedication: async (callId: string, pickedUp: boolean, doseTaken: boolean) =>
      void (await db.query(
        `INSERT INTO medication_logs(call_id,picked_up,dose_taken) VALUES ($1,$2,$3)
         ON CONFLICT (call_id) DO UPDATE SET picked_up=EXCLUDED.picked_up, dose_taken=EXCLUDED.dose_taken, created_at=now()`,
        [callId, pickedUp, doseTaken],
      )),
    saveTriage: async (callId: string, fever: boolean, swelling: boolean, pain: number, redFlag: boolean) =>
      void (await db.query(
        `INSERT INTO triage_logs(call_id,fever,swelling,pain_score,red_flag) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (call_id) DO UPDATE SET fever=EXCLUDED.fever, swelling=EXCLUDED.swelling, pain_score=EXCLUDED.pain_score, red_flag=EXCLUDED.red_flag, created_at=now()`,
        [callId, fever, swelling, pain, redFlag],
      )),

    /** One alert per (call, reason); repeats are no-ops and are not re-logged. */
    async raiseAlert(callId: string, patientId: string, reason: string, details: string) {
      const ins = await db.query<{ id: number }>(
        'INSERT INTO alerts(call_id,patient_id,reason,details) VALUES ($1,$2,$3,$4) ON CONFLICT (call_id, reason) DO NOTHING RETURNING id',
        [callId, patientId, reason, details],
      );
      if (!ins.length) return { id: Number((await one<{ id: number }>('SELECT id FROM alerts WHERE call_id=$1 AND reason=$2', callId, reason))!.id), isNew: false };
      const id = Number(ins[0].id);
      const entry = { ts: new Date().toISOString(), level: 'NURSE_ALERT', alert_id: id, call_id: callId, patient_id: patientId, reason, details };
      console.warn(`[NURSE ALERT] ${JSON.stringify(entry)}`);
      mkdirSync(dirname(alertLogPath), { recursive: true });
      appendFileSync(alertLogPath, JSON.stringify(entry) + '\n');
      publish({ call_id: callId, type: 'alert', reason, details });
      return { id, isNew: true };
    },
    listAlerts: (callId: string) => db.query('SELECT id, call_id, patient_id, reason, details FROM alerts WHERE call_id=$1 ORDER BY id', [callId]),

    // ---- tool-call idempotency ----
    async getResult(toolCallId: string) {
      return (await one<{ response: string }>('SELECT response FROM tool_results WHERE tool_call_id=$1', toolCallId))?.response;
    },
    saveResult: async (toolCallId: string, callId: string, tool: string, response: string) =>
      void (await db.query('INSERT INTO tool_results(tool_call_id,call_id,tool,response) VALUES ($1,$2,$3,$4) ON CONFLICT (tool_call_id) DO NOTHING', [toolCallId, callId, tool, response])),
    /** Serializes concurrent requests that carry the same tool_call_id (use inside a transaction). */
    lockToolCall: async (toolCallId: string) => void (await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [toolCallId])),
  };
}

export interface Store extends ReturnType<typeof makeCore> {
  /** Runs fn on a store bound to one database transaction (commit on return, rollback on throw). */
  transaction<T>(fn: (s: Store) => Promise<T>): Promise<T>;
}

export function makeStore(db: Db, alertLogPath: string): Store {
  return { ...makeCore(db, alertLogPath), transaction: (fn) => db.transaction((tx) => fn(makeStore(tx, alertLogPath))) };
}

/** Opens the database, applies migrations and seeds the demo patient into an empty database. */
export async function createStore(target: string, alertLogPath: string): Promise<Store & { close(): Promise<void> }> {
  const db: OpenDb = openDb(target);
  await migrate(db);
  const store = makeStore(db, alertLogPath);
  await store.seedDemoIfEmpty();
  return Object.assign(store, { close: () => db.close() });
}

let singleton: Promise<Store> | undefined;
export function getStore(): Promise<Store> {
  return (singleton ??= (() => {
    const c = serverConfig();
    // Without a real database the data would live on the host's disk and vanish on every deploy.
    if (process.env.RENDER && !c.DATABASE_URL) throw new Error('DATABASE_URL is required on Render (the local database is wiped on every deploy)');
    return createStore(c.DATABASE_URL ?? c.DB_PATH, c.NURSE_ALERT_LOG);
  })());
}
