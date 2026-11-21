import assert from 'node:assert/strict';
import test from 'node:test';
import { basicAuth } from './auth.js';

const header = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;

function run(authorization?: string) {
  let status = 0, nexted = false;
  const res: any = { set() { return res; }, status(c: number) { status = c; return res; }, send() { return res; } };
  basicAuth()({ header: () => authorization } as any, res, () => { nexted = true; });
  return { status, nexted };
}

test('basic auth: rejects missing/wrong credentials, accepts right ones (password may contain colons)', () => {
  Object.assign(process.env, { BASIC_AUTH_USER: 'admin', BASIC_AUTH_PASS: 'p:w:d' });
  assert.deepEqual(run(), { status: 401, nexted: false });
  assert.deepEqual(run(header('admin', 'nope')), { status: 401, nexted: false });
  assert.deepEqual(run(header('root', 'p:w:d')), { status: 401, nexted: false });
  assert.deepEqual(run(header('admin', 'p:w:d')), { status: 0, nexted: true });
});

test('no password: open locally, refuses to start on Render', () => {
  delete process.env.BASIC_AUTH_PASS;
  delete process.env.RENDER;
  assert.equal(run().nexted, true);
  process.env.RENDER = 'true';
  assert.throws(() => basicAuth(), /BASIC_AUTH_PASS is required/);
  delete process.env.RENDER;
});
