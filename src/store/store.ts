import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { serverConfig } from '../config.js';
import { publish } from '../events.js';

export interface Patient { id: string; first_name: string; birth_month: number; birth_day: number; medications: string[] }
export interface CallRow { call_id: string; patient_id: string; verified: number; failed_attempts: number }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS patients(id TEXT PRIMARY KEY, first_name TEXT NOT NULL, birth_month INTEGER NOT NULL, birth_day INTEGER NOT NULL, medications TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS calls(call_id TEXT PRIMARY KEY, patient_id TEXT NOT NULL, verified INTEGER NOT NULL DEFAULT 0, failed_attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tool_results(tool_call_id TEXT PRIMARY KEY, call_id TEXT NOT NULL, tool TEXT NOT NULL, response TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS medication_logs(call_id TEXT PRIMARY KEY, picked_up INTEGER NOT NULL, dose_taken INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS triage_logs(call_id TEXT PRIMARY KEY, fever INTEGER NOT NULL, swelling INTEGER NOT NULL, pain_score INTEGER NOT NULL, red_flag INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS alerts(id INTEGER PRIMARY KEY AUTOINCREMENT, call_id TEXT NOT NULL, patient_id TEXT NOT NULL, reason TEXT NOT NULL, details TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(call_id, reason));
`;

// Fictional demo patient (not real PHI). Replace with your EHR lookup for production.
const DEMO = { id: 'demo-001', first_name: 'Alex', birth_month: 3, birth_day: 14, medications: ['Amoxicillin 500 milligrams', 'Ibuprofen 400 milligrams'] };

const now = () => new Date().toISOString();
const flag = (b: boolean) => (b ? 1 : 0);

export function createStore(dbPath: string, alertLogPath: string) {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  db.prepare('INSERT OR IGNORE INTO patients VALUES (?,?,?,?,?)')
    .run(DEMO.id, DEMO.first_name, DEMO.birth_month, DEMO.birth_day, JSON.stringify(DEMO.medications));

  const one = <T>(sql: string, ...p: (string | number)[]) => db.prepare(sql).get(...p) as unknown as T | undefined;

  return {
    getPatient(id: string): Patient | undefined {
      const r = one<Omit<Patient, 'medications'> & { medications: string }>('SELECT * FROM patients WHERE id=?', id);
      return r && { ...r, medications: JSON.parse(r.medications) };
    },
    /** Starting a call under an existing id resets its verification state. */
    createCall(callId: string, patientId: string) {
      if (!this.getPatient(patientId)) throw new Error(`unknown patient ${patientId}`);
      db.prepare('INSERT OR REPLACE INTO calls VALUES (?,?,0,0,?)').run(callId, patientId, now());
    },
    getCall: (callId: string) => one<CallRow>('SELECT * FROM calls WHERE call_id=?', callId),
    markVerified: (callId: string) => void db.prepare('UPDATE calls SET verified=1 WHERE call_id=?').run(callId),
    addFailedAttempt(callId: string): number {
      db.prepare('UPDATE calls SET failed_attempts=failed_attempts+1 WHERE call_id=?').run(callId);
      return one<CallRow>('SELECT * FROM calls WHERE call_id=?', callId)!.failed_attempts;
    },
    saveMedication: (callId: string, pickedUp: boolean, doseTaken: boolean) =>
      void db.prepare('INSERT OR REPLACE INTO medication_logs VALUES (?,?,?,?)').run(callId, flag(pickedUp), flag(doseTaken), now()),
    saveTriage: (callId: string, fever: boolean, swelling: boolean, pain: number, redFlag: boolean) =>
      void db.prepare('INSERT OR REPLACE INTO triage_logs VALUES (?,?,?,?,?,?)').run(callId, flag(fever), flag(swelling), pain, flag(redFlag), now()),

    /** One alert per (call, reason); repeats are no-ops and are not re-logged. */
    raiseAlert(callId: string, patientId: string, reason: string, details: string) {
      const ts = now();
      const ins = db.prepare('INSERT OR IGNORE INTO alerts(call_id,patient_id,reason,details,created_at) VALUES (?,?,?,?,?)')
        .run(callId, patientId, reason, details, ts);
      const id = one<{ id: number }>('SELECT id FROM alerts WHERE call_id=? AND reason=?', callId, reason)!.id;
      const isNew = Number(ins.changes) === 1;
      if (isNew) {
        const entry = { ts, level: 'NURSE_ALERT', alert_id: id, call_id: callId, patient_id: patientId, reason, details };
        console.warn(`[NURSE ALERT] ${JSON.stringify(entry)}`);
        mkdirSync(dirname(alertLogPath), { recursive: true });
        appendFileSync(alertLogPath, JSON.stringify(entry) + '\n');
        publish({ call_id: callId, type: 'alert', reason, details });
      }
      return { id, isNew };
    },
    listAlerts: (callId: string) => db.prepare('SELECT * FROM alerts WHERE call_id=? ORDER BY id').all(callId),

    getResult: (toolCallId: string) => one<{ response: string }>('SELECT response FROM tool_results WHERE tool_call_id=?', toolCallId)?.response,
    saveResult: (toolCallId: string, callId: string, tool: string, response: string) =>
      void db.prepare('INSERT INTO tool_results VALUES (?,?,?,?,?)').run(toolCallId, callId, tool, response, now()),

    transaction<T>(fn: () => T): T {
      db.exec('BEGIN');
      try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
}
export type Store = ReturnType<typeof createStore>;

let singleton: Store | undefined;
export function getStore(): Store {
  const c = serverConfig();
  return (singleton ??= createStore(c.DB_PATH, c.NURSE_ALERT_LOG));
}
