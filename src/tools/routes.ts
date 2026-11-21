import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { webhookSecret } from '../config.js';
import { publish } from '../events.js';
import { getStore } from '../store/store.js';
import { runTool, tools } from './registry.js';

export function webhookRouter(): Router {
  const r = Router();

  r.use((req, res, next) => {
    const got = Buffer.from(req.header('x-webhook-secret') ?? '');
    const want = Buffer.from(webhookSecret());
    if (got.length !== want.length || !timingSafeEqual(got, want)) {
      return void res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    next();
  });

  for (const t of tools) {
    r.post(`/${t.path}`, (req, res) => {
      const out = runTool(getStore(), t, req.body);
      // replays are not re-published, so the live feed shows each real call once
      if (out.fresh) publish({ call_id: out.call_id!, type: 'tool', tool: t.name, args: out.args, result: out.body });
      res.status(out.status).json(out.body);
    });
  }
  return r;
}
