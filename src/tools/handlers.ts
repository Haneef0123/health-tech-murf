import type { Store } from '../store/store.js';

const MAX_VERIFY_ATTEMPTS = 2;
export const NURSE_MESSAGE =
  'A nurse will follow up with you. If your symptoms get worse, please seek urgent or emergency care right away.';

// Deterministic rules live here, not in the LLM. `next` tells the model what to do after each result.

export function verifyPatient(s: Store, callId: string, a: { birth_month: number; birth_day: number }) {
  const call = s.getCall(callId);
  if (!call) return { ok: false, error: 'unknown_call' };
  const patient = s.getPatient(call.patient_id)!;
  if (call.verified) return verifiedPayload(patient);
  if (call.failed_attempts >= MAX_VERIFY_ATTEMPTS) return locked();

  if (patient.birth_month === a.birth_month && patient.birth_day === a.birth_day) {
    s.markVerified(callId);
    return verifiedPayload(patient);
  }
  const attempts = s.addFailedAttempt(callId);
  return attempts >= MAX_VERIFY_ATTEMPTS
    ? locked()
    : { ok: true, verified: false, next: 'That did not match. Ask once more for the birth month and day. Share no health details.' };
}

const verifiedPayload = (p: { first_name: string; medications: string[] }) => ({
  ok: true,
  verified: true,
  first_name: p.first_name,
  medications: p.medications,
  next: 'Verified. Move to the medication check using only these medications.',
});
const locked = () => ({
  ok: true,
  verified: false,
  locked: true,
  next: 'Verification failed. Politely end the call, say the care team will reach out, and share no health details.',
});

const NOT_VERIFIED = { ok: false, error: 'not_verified', next: 'Verify the patient first.' };

export function logMedicationStatus(s: Store, callId: string, a: { prescriptions_picked_up: boolean; dose_taken_today: boolean }) {
  if (!s.getCall(callId)?.verified) return NOT_VERIFIED;
  s.saveMedication(callId, a.prescriptions_picked_up, a.dose_taken_today);
  return {
    ok: true,
    follow_up_needed: !a.prescriptions_picked_up || !a.dose_taken_today,
    next: 'Logged. Move to the symptom check: fever, unusual swelling, and pain from 0 to 10.',
  };
}

export function recordSymptomTriage(s: Store, callId: string, a: { fever: boolean; unusual_swelling: boolean; pain_score: number }) {
  const call = s.getCall(callId);
  if (!call?.verified) return NOT_VERIFIED;
  const reasons = [a.fever && 'fever', a.unusual_swelling && 'unusual swelling', a.pain_score >= 7 && `pain ${a.pain_score}/10`].filter(Boolean) as string[];
  const redFlag = reasons.length > 0;
  s.saveTriage(callId, a.fever, a.unusual_swelling, a.pain_score, redFlag);
  // Safety net: the alert exists even if the model forgets to call escalateToNurse.
  if (redFlag) s.raiseAlert(callId, call.patient_id, 'red_flag_symptoms', reasons.join(', '));
  return redFlag
    ? { ok: true, red_flag: true, reasons, next: 'Red flag. Call escalateToNurse now, then give the nurse follow-up message.' }
    : { ok: true, red_flag: false, next: 'No red flags. Thank the patient and close the call.' };
}

export function escalateToNurse(s: Store, callId: string, a: { reason: 'red_flag_symptoms' | 'clinical_question' | 'emergency'; details: string }) {
  const call = s.getCall(callId);
  if (!call) return { ok: false, error: 'unknown_call' }; // never blocked on verification: escalation is a safety path
  const { id } = s.raiseAlert(callId, call.patient_id, a.reason, a.details);
  return { ok: true, alert_id: id, message_to_patient: NURSE_MESSAGE, next: 'Say the message_to_patient, then close the call.' };
}
