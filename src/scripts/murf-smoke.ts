import { murfSmoke } from '../murf/smoke.js';

const r = await murfSmoke().catch((e: Error) => ({ ok: false, error: e.message }));
console.log(JSON.stringify(r, null, 2));
process.exit(r.ok ? 0 : 1);
