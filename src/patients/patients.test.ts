import assert from 'node:assert/strict';
import test from 'node:test';
import { migrate } from '../store/schema.js';
import { openDb } from '../store/db.js';
import { createStore } from '../store/store.js';
import { runTool, tools } from '../tools/registry.js';
import { patientInput } from './schema.js';

const base = { first_name: 'Sam', birth_date: '1985-07-04', consent_ai_call: true, medications: [{ name: 'Metformin', dose: '500 mg', schedule: 'with dinner' }] };
const mk = async () => createStore(':memory:', '/tmp/patients-test-alerts.log');

test('profile create, read, update and soft delete', async () => {
  const s = await mk();
  const p = await s.createPatient(patientInput.parse(base));
  assert.equal(p.first_name, 'Sam');
  assert.equal(p.birth_date, '1985-07-04');
  assert.deepEqual(p.medications, [{ name: 'Metformin', dose: '500 mg', schedule: 'with dinner' }]);

  const u = await s.updatePatient(p.id, patientInput.parse({ ...base, first_name: 'Samir', medications: [{ name: 'Aspirin' }] }));
  assert.equal(u!.first_name, 'Samir');
  assert.deepEqual(u!.medications, [{ name: 'Aspirin', dose: '', schedule: '' }]); // list is replaced, not appended
  assert.equal(await s.updatePatient('missing', patientInput.parse(base)), undefined);

  assert.equal((await s.listPatients()).some((x) => x.id === p.id), true);
  assert.equal(await s.deactivatePatient(p.id), true);
  assert.equal((await s.listPatients()).some((x) => x.id === p.id), false); // hidden from the default list
  assert.equal((await s.listPatients(true)).some((x) => x.id === p.id), true);
});

test('profile validation rejects impossible dates and missing names', () => {
  assert.equal(patientInput.safeParse({ ...base, birth_date: '2024-02-31' }).success, false);
  assert.equal(patientInput.safeParse({ ...base, birth_date: '04/07/1985' }).success, false);
  assert.equal(patientInput.safeParse({ ...base, first_name: '  ' }).success, false);
  assert.equal(patientInput.safeParse({ ...base, medications: [{ name: '' }] }).success, false);
});

test('the call verifies against the patient\'s own birth date and returns their own medications', async () => {
  const s = await mk();
  const p = await s.createPatient(patientInput.parse(base));
  await s.createCall('pc1', p.id);
  const verifyTool = tools.find((t) => t.name === 'verifyPatient')!;
  const wrong = await runTool(s, verifyTool, { call_id: 'pc1', tool_call_id: 'a', birth_month: 3, birth_day: 14 }); // the demo patient's date
  assert.equal((wrong.body as any).verified, false);
  const ok = await runTool(s, verifyTool, { call_id: 'pc1', tool_call_id: 'b', birth_month: 7, birth_day: 4 });
  assert.equal((ok.body as any).verified, true);
  assert.deepEqual((ok.body as any).medications, ['Metformin 500 mg, with dinner']);
});

test('migrations are idempotent and a call needs an existing patient', async () => {
  const db = openDb(':memory:');
  await migrate(db);
  await migrate(db); // second run is a no-op
  const s = await mk();
  await assert.rejects(s.createCall('c', 'nobody'), /unknown patient/);
});
