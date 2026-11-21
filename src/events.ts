import { EventEmitter } from 'node:events';

export interface CallEvent {
  ts: string;
  call_id: string;
  type: 'tool' | 'alert';
  tool?: string;
  args?: unknown;
  result?: unknown;
  reason?: string;
  details?: string;
}

const MAX_PER_CALL = 200;
const bus = new EventEmitter();
// shortcut: in-memory history is never evicted per call; fine for local testing, move to the DB or a TTL for production.
const history = new Map<string, CallEvent[]>();

export function publish(e: Omit<CallEvent, 'ts'>) {
  const ev: CallEvent = { ts: new Date().toISOString(), ...e };
  const h = history.get(e.call_id) ?? [];
  h.push(ev);
  history.set(e.call_id, h.slice(-MAX_PER_CALL));
  bus.emit(e.call_id, ev);
}

/** Replays the call's history, then streams live events. Returns an unsubscribe function. */
export function subscribe(callId: string, fn: (e: CallEvent) => void): () => void {
  history.get(callId)?.forEach(fn);
  bus.on(callId, fn);
  return () => void bus.off(callId, fn);
}
