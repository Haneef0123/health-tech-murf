import { getStore } from '../store/store.js';

// Lets you exercise the webhooks with curl without starting an Agora agent (which normally registers the call).
// Use the same DATABASE_URL / DB_PATH as the server. With the default local database, stop the server first (one process at a time).
const [callId, patientId = 'demo-001'] = process.argv.slice(2);
if (!callId) {
  console.error('usage: npm run call:register -- <callId> [patientId]');
  process.exit(1);
}
await (await getStore()).createCall(callId, patientId);
console.log(`registered ${callId} for ${patientId}`);
process.exit(0);
