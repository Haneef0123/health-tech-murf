import { getStore } from '../store/store.js';

// Lets you exercise the webhooks with curl without starting an Agora agent (which normally registers the call).
const [callId, patientId = 'demo-001'] = process.argv.slice(2);
if (!callId) {
  console.error('usage: npm run call:register -- <callId> [patientId]');
  process.exit(1);
}
getStore().createCall(callId, patientId);
console.log(`registered ${callId} for ${patientId}`);
