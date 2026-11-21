import { type Patient, describeMedication } from '../patients/schema.js';
import type { Store } from '../store/store.js';

const MAX_VERIFY_ATTEMPTS = 2; // per call
// Across calls: stops "hang up and retry" guessing. shortcut: also means someone can lock a real patient out for an hour by guessing; add staff unlock.
const MAX_PATIENT_FAILURES = 4;
const PATIENT_LOCK_WINDOW_MIN = 60;
export const NURSE_MESSAGE =
  'A nurse will follow up with you. If your symptoms get worse, please seek urgent or emergency care right away.';

// Deterministic rules live here, not in the LLM. `next` tells the model what to do after each result.

export async function verifyPatient(s: Store, callId: string, a: { birth_month: number; birth_day: number }) {
  const call = await s.getCall(callId);
  if (!call) return { ok: false, error: 'unknown_call' };
  const patient = (await s.getPatient(call.patient_id))!;
  if (call.verified) return verifiedPayload(patient);
  if (call.failed_attempts >= MAX_VERIFY_ATTEMPTS || (await s.recentVerifyFailures(patient.id, PATIENT_LOCK_WINDOW_MIN)) >= MAX_PATIENT_FAILURES) return locked();

  const [, month, day] = patient.birth_date.split('-').map(Number); // YYYY-MM-DD
  if (month === a.birth_month && day === a.birth_day) {
    await s.markVerified(callId);
    return verifiedPayload(patient);
  }
  await s.recordVerifyFailure(patient.id);
  const attempts = await s.addFailedAttempt(callId);
  return attempts >= MAX_VERIFY_ATTEMPTS
    ? locked()
    : { ok: true, verified: false, next: 'That did not match. Ask once more for the birth month and day. Share no health details.' };
}

const verifiedPayload = (p: Patient) => ({
  ok: true,
  verified: true,
  first_name: p.first_name,
  ...(p.procedure_name && { procedure: p.procedure_name }),
  medications: p.medications.map(describeMedication),
  next: 'Verified. Move to the medication check using only these medications; ask about them together, not one by one.',
});
const locked = () => ({
  ok: true,
  verified: false,
  locked: true,
  next: 'Verification failed. Politely end the call, say the care team will reach out, and share no health details.',
});

const NOT_VERIFIED = { ok: false, error: 'not_verified', next: 'Verify the patient first.' };

export async function logMedicationStatus(s: Store, callId: string, a: { prescriptions_picked_up: boolean; dose_taken_today: boolean }) {
  if (!(await s.getCall(callId))?.verified) return NOT_VERIFIED;
  await s.saveMedication(callId, a.prescriptions_picked_up, a.dose_taken_today);
  return {
    ok: true,
    follow_up_needed: !a.prescriptions_picked_up || !a.dose_taken_today,
    next: 'Logged. Move to the symptom check: fever, unusual swelling, and pain from 0 to 10.',
  };
}

export async function recordSymptomTriage(s: Store, callId: string, a: { fever: boolean; unusual_swelling: boolean; pain_score: number }) {
  const call = await s.getCall(callId);
  if (!call?.verified) return NOT_VERIFIED;
  const reasons = [a.fever && 'fever', a.unusual_swelling && 'unusual swelling', a.pain_score >= 7 && `pain ${a.pain_score}/10`].filter(Boolean) as string[];
  const redFlag = reasons.length > 0;
  await s.saveTriage(callId, a.fever, a.unusual_swelling, a.pain_score, redFlag);
  // Safety net: the alert exists even if the model forgets to call escalateToNurse.
  if (redFlag) await s.raiseAlert(callId, call.patient_id, 'red_flag_symptoms', reasons.join(', '));
  return redFlag
    ? { ok: true, red_flag: true, reasons, next: 'Red flag. Call escalateToNurse now, then give the nurse follow-up message.' }
    : { ok: true, red_flag: false, next: 'No red flags. Thank the patient and close the call.' };
}

export async function escalateToNurse(s: Store, callId: string, a: { reason: 'red_flag_symptoms' | 'clinical_question' | 'emergency'; details: string }) {
  const call = await s.getCall(callId);
  if (!call) return { ok: false, error: 'unknown_call' }; // never blocked on verification: escalation is a safety path
  const { id } = await s.raiseAlert(callId, call.patient_id, a.reason, a.details);
  return { ok: true, alert_id: id, message_to_patient: NURSE_MESSAGE, next: 'Say the message_to_patient, then close the call.' };
}
