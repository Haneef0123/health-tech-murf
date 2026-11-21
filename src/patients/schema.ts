import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD').refine((s) => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s); // rejects 2024-02-31
}, 'not a real date');
const text = (max: number) => z.string().trim().max(max).default('');

export const medicationInput = z.object({ name: z.string().trim().min(1).max(120), dose: text(120), schedule: text(120) });

export const patientInput = z.object({
  first_name: z.string().trim().min(1).max(80),
  last_name: text(80),
  birth_date: isoDate,
  phone: text(32),
  language: z.string().trim().min(2).max(16).default('en-US'),
  discharge_date: isoDate.nullable().default(null),
  procedure_name: text(200),
  emergency_contact_name: text(80),
  emergency_contact_phone: text(32),
  consent_ai_call: z.boolean().default(false),
  medications: z.array(medicationInput).max(30).default([]),
});

export type Medication = z.output<typeof medicationInput>;
export type PatientInput = z.output<typeof patientInput>;
export interface Patient extends PatientInput { id: string; active: boolean; created_at: string }

/** How a medication is spoken to the model, e.g. "Amoxicillin 500 milligrams, twice a day". */
export const describeMedication = (m: Medication) => [m.name, m.dose].filter(Boolean).join(' ') + (m.schedule ? `, ${m.schedule}` : '');
