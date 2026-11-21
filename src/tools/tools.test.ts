import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createStore } from '../store/store.js';
import { runTool, tools } from './registry.js';

const tool = (name: string) => tools.find((t) => t.name === name)!;

async function setup() {
  const log = join(mkdtempSync(join(tmpdir(), 'alerts-')), 'alerts.log');
  const store = await createStore(':memory:', log);
  await store.createCall('c1', 'demo-001');
  let n = 0;
  const call = (name: string, args: object, callId = 'c1') => runTool(store, tool(name), { call_id: callId, tool_call_id: `t${++n}`, ...args });
  return { store, log, call };
}
const verify = { birth_month: 3, birth_day: 14 }; // demo patient: 1990-03-14

test('no medication details before verification; locks after 2 failures', async () => {
  const { call } = await setup();
  assert.equal(((await call('logMedicationStatus', { prescriptions_picked_up: true, dose_taken_today: true })).body as any).error, 'not_verified');
  const wrong = { birth_month: 1, birth_day: 1 };
  const r1 = (await call('verifyPatient', wrong)).body as any;
  assert.equal(r1.verified, false);
  assert.equal(r1.medications, undefined);
  assert.equal(((await call('verifyPatient', wrong)).body as any).locked, true);
  assert.equal(((await call('verifyPatient', verify)).body as any).locked, true); // correct answer too late
});

test('correct identity returns procedure and medications; full happy path raises no alert', async () => {
  const { call, store } = await setup();
  const v = (await call('verifyPatient', verify)).body as any;
  assert.equal(v.verified, true);
  assert.equal(v.procedure, 'knee surgery');
  assert.deepEqual(v.medications[0], 'Amoxicillin 500 milligrams, three times a day');
  assert.equal(((await call('logMedicationStatus', { prescriptions_picked_up: true, dose_taken_today: true })).body as any).ok, true);
  assert.equal(((await call('recordSymptomTriage', { fever: false, unusual_swelling: false, pain_score: 6 })).body as any).red_flag, false);
  assert.equal((await store.listAlerts('c1')).length, 0);
});

test('pain >= 7 alerts once, even if the model also escalates; alert is logged once', async () => {
  const { call, store, log } = await setup();
  await call('verifyPatient', verify);
  assert.equal(((await call('recordSymptomTriage', { fever: false, unusual_swelling: false, pain_score: 7 })).body as any).red_flag, true);
  const e = (await call('escalateToNurse', { reason: 'red_flag_symptoms', details: 'pain 7' })).body as any;
  assert.match(e.message_to_patient, /nurse will follow up/);
  assert.equal((await store.listAlerts('c1')).length, 1);
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 1);
});

test('replaying a tool_call_id returns the stored result and does not double count', async () => {
  const { store } = await setup();
  const wrong = { call_id: 'c1', tool_call_id: 'same', birth_month: 1, birth_day: 1 };
  const a = await runTool(store, tool('verifyPatient'), wrong);
  const b = await runTool(store, tool('verifyPatient'), wrong);
  assert.deepEqual(a.body, b.body);
  assert.equal(a.fresh, true);
  assert.equal(b.fresh, undefined); // replays are not re-published to the live feed
  assert.equal((await store.getCall('c1'))!.failed_attempts, 1);
});

test('concurrent duplicates of one tool_call_id run once', async () => {
  const { store } = await setup();
  const req = { call_id: 'c1', tool_call_id: 'dup', birth_month: 1, birth_day: 1 };
  const results = await Promise.all([1, 2, 3].map(() => runTool(store, tool('verifyPatient'), req)));
  assert.equal(results.filter((r) => r.fresh).length, 1);
  assert.equal((await store.getCall('c1'))!.failed_attempts, 1);
});

test('invalid arguments are rejected without side effects', async () => {
  const { call, store } = await setup();
  assert.equal((await call('verifyPatient', { birth_month: 13, birth_day: 1 })).status, 400);
  assert.equal((await call('recordSymptomTriage', { fever: 'yes', unusual_swelling: false, pain_score: 2 })).status, 400);
  assert.equal((await store.getCall('c1'))!.failed_attempts, 0);
});

test('wrong guesses across several calls lock the patient, even for the right answer', async () => {
  const { store, call } = await setup();
  const wrong = { birth_month: 1, birth_day: 1 };
  for (const id of ['x1', 'x2']) {
    await store.createCall(id, 'demo-001');
    await call('verifyPatient', wrong, id);
    await call('verifyPatient', wrong, id); // 2 failures per call, 4 total
  }
  await store.createCall('x3', 'demo-001'); // a fresh call has its own counter at zero
  assert.equal(((await call('verifyPatient', verify, 'x3')).body as any).locked, true);
});
