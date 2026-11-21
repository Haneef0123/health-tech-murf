import express from 'express';
import { ZodError, z } from 'zod';
import { startAgent, stopAgent } from './agora/agent.js';
import { basicAuth } from './auth.js';
import { serverConfig } from './config.js';
import { subscribe } from './events.js';
import { murfSmoke } from './murf/smoke.js';
import { webhookRouter } from './tools/routes.js';

const app = express();
app.use(express.json());

// Open routes: webhooks have their own secret header; /health is for the host's health check.
app.use('/webhooks', webhookRouter());
app.get('/health', (_req, res) => void res.json({ ok: true }));

// Everything below needs the login (when BASIC_AUTH_PASS is set).
app.use(basicAuth());
app.use(express.static('public')); // browser test client (built by `npm run build:client`)

// Live call feed for the test client.
app.get('/api/calls/:callId/events', (req, res) => {
  const callId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).parse(req.params.callId);
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  const off = subscribe(callId, (e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
  req.on('close', off);
});

// Standalone Murf check: run this before starting a full Agora session.
app.get('/api/murf-test', async (_req, res) => {
  const r = await murfSmoke();
  res.status(r.ok ? 200 : 502).json(r);
});

app.post('/api/agent/start', async (req, res) => {
  const body = z.object({ channel: z.string().optional(), patientId: z.string().optional() }).parse(req.body ?? {});
  const channel = body.channel ?? `checkin-${Date.now().toString(36)}`;
  res.json(await startAgent({ channel, patientId: body.patientId }));
});

app.post('/api/agent/stop', async (req, res) => {
  const { agentId } = z.object({ agentId: z.string().min(1) }).parse(req.body);
  await stopAgent(agentId);
  res.json({ ok: true });
});

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof ZodError) return void res.status(400).json({ error: err.issues });
  res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
});

const { PORT } = serverConfig();
app.listen(PORT, () => console.log(`listening on port ${PORT}`));
