import { Router } from 'express';
import { z } from 'zod';
import { HttpError } from '../errors.js';
import { getStore } from '../store/store.js';
import { patientInput } from './schema.js';

const id = (v: unknown) => z.string().min(1).max(64).parse(v);

/** Staff-facing patient profile API. Mounted behind the login, never public. */
export function patientsRouter(): Router {
  const r = Router();
  r.get('/', async (req, res) => res.json(await (await getStore()).listPatients(req.query.all === '1')));
  r.post('/', async (req, res) => res.status(201).json(await (await getStore()).createPatient(patientInput.parse(req.body))));
  r.get('/:id', async (req, res) => {
    const p = await (await getStore()).getPatient(id(req.params.id));
    if (!p) throw new HttpError(404, 'patient not found');
    res.json(p);
  });
  r.put('/:id', async (req, res) => {
    const p = await (await getStore()).updatePatient(id(req.params.id), patientInput.parse(req.body));
    if (!p) throw new HttpError(404, 'patient not found');
    res.json(p);
  });
  r.delete('/:id', async (req, res) => {
    if (!(await (await getStore()).deactivatePatient(id(req.params.id)))) throw new HttpError(404, 'patient not found');
    res.json({ ok: true });
  });
  return r;
}
