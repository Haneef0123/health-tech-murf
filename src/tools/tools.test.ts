import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createStore } from '../store/store.js';
import { runTool, tools } from './registry.js';

const tool = (name: string) => tools.find((t) => t.name === name)!;

function setup() {
  const log = join(mkdtempSync(join(tmpdir(), 'alerts-')), 'alerts.log');
  const store = createStore(':memory:', log);
  store.createCall('c1', 'demo-001');
  let n = 0;
  const call = (name: string, args: object) => runTool(store, tool(name), { call_id: 'c1', tool_call_id: `t${++n}`, ...args });
  return { store, log, call };
}
const verify = { birth_month: 3, birth_day: 14 };

test('no medication details before verification; locks after 2 failures', () => {
  const { call } = setup();
  assert.deepEqual((call('logMedicationStatus', { prescriptions_picked_up: true, dose_taken_today: true }).body as any).error, 'not_verified');
  const wrong = { birth_month: 1, birth_day: 1 };
  const r1 = call('verifyPatient', wrong).body as any;
  assert.equal(r1.verified, false);
  assert.equal(r1.medications, undefined);
  assert.equal((call('verifyPatient', wrong).body as any).locked, true);
  assert.equal((call('verifyPatient', verify).body as any).locked, true); // correct answer too late
});

test('correct identity returns medications; full happy path raises no alert', () => {
  const { call, store } = setup();
  const v = call('verifyPatient', verify).body as any;
  assert.equal(v.verified, true);
  assert.ok(v.medications.length > 0);
  assert.equal((call('logMedicationStatus', { prescriptions_picked_up: true, dose_taken_today: true }).body as any).ok, true);
  assert.equal((call('recordSymptomTriage', { fever: false, unusual_swelling: false, pain_score: 6 }).body as any).red_flag, false);
  assert.equal(store.listAlerts('c1').length, 0);
});

test('pain >= 7 alerts once, even if the model also escalates; alert is logged once', () => {
  const { call, store, log } = setup();
  call('verifyPatient', verify);
  assert.equal((call('recordSymptomTriage', { fever: false, unusual_swelling: false, pain_score: 7 }).body as any).red_flag, true);
  const e = call('escalateToNurse', { reason: 'red_flag_symptoms', details: 'pain 7' }).body as any;
  assert.match(e.message_to_patient, /nurse will follow up/);
  assert.equal(store.listAlerts('c1').length, 1);
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 1);
});

test('replaying a tool_call_id returns the stored result and does not double count', () => {
  const { store } = setup();
  const wrong = { call_id: 'c1', tool_call_id: 'same', birth_month: 1, birth_day: 1 };
  const a = runTool(store, tool('verifyPatient'), wrong);
  const b = runTool(store, tool('verifyPatient'), wrong);
  assert.deepEqual(a.body, b.body);
  assert.equal(a.fresh, true);
  assert.equal(b.fresh, undefined); // replays are not re-published to the live feed
  assert.equal(store.getCall('c1')!.failed_attempts, 1);
});

test('invalid arguments are rejected without side effects', () => {
  const { call, store } = setup();
  assert.equal(call('verifyPatient', { birth_month: 13, birth_day: 1 }).status, 400);
  assert.equal(call('recordSymptomTriage', { fever: 'yes', unusual_swelling: false, pain_score: 2 }).status, 400);
  assert.equal(store.getCall('c1')!.failed_attempts, 0);
});
