import WebSocket from 'ws';
import { murfConfig } from '../config.js';

export interface MurfSmokeResult {
  ok: boolean;
  model: string;
  voiceId: string;
  audioBytes: number;
  msToFirstAudio?: number;
  region?: string;
  warnings: string[];
  error?: string;
}

/** Opens Murf's stream-input socket, synthesizes one sentence, and reports what came back. Key is never logged. */
export function murfSmoke(text = 'Hello, this is a quick test of the check-in voice.'): Promise<MurfSmokeResult> {
  const m = murfConfig();
  const url = new URL(m.MURF_WS_URL);
  url.search = new URLSearchParams({
    'api-key': m.MURF_API_KEY,
    model: m.MURF_MODEL,
    sample_rate: String(m.MURF_SAMPLE_RATE),
    channel_type: 'MONO',
    format: 'PCM',
  }).toString();

  const result: MurfSmokeResult = { ok: false, model: m.MURF_MODEL, voiceId: m.MURF_VOICE_ID, audioBytes: 0, warnings: [] };
  const contextId = 'smoke-1';
  const t0 = Date.now();

  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const done = (err?: string) => {
      clearTimeout(timer);
      if (err && !result.error) result.error = err;
      result.ok = !result.error && result.audioBytes > 0;
      ws.removeAllListeners();
      ws.on('error', () => {});
      ws.close();
      resolve(result);
    };
    const timer = setTimeout(() => done('timeout after 15s'), 15_000);

    ws.on('open', () => {
      // voice_config must precede text, with the same context_id
      ws.send(JSON.stringify({
        context_id: contextId,
        voice_config: { voice_id: m.MURF_VOICE_ID, locale: m.MURF_LOCALE, style: 'Conversational', rate: m.MURF_RATE, pitch: m.MURF_PITCH },
      }));
      ws.send(JSON.stringify({ context_id: contextId, text, end: true }));
    });
    ws.on('message', (raw) => {
      const d = JSON.parse(raw.toString());
      if (d.audio) {
        result.msToFirstAudio ??= Date.now() - t0;
        result.audioBytes += Buffer.from(d.audio, 'base64').length;
      }
      if (d.warning) result.warnings.push(`${d.warning_code}: ${d.warning}`);
      if (d.error) return done(`${d.error_code}: ${d.error}`);
      if (d.final) {
        result.region = d.concurrency?.region;
        done();
      }
    });
    ws.on('unexpected-response', (_req, res) => done(`HTTP ${res.statusCode} on upgrade (bad key or URL?)`));
    ws.on('error', (e) => done(e.message));
    ws.on('close', (code, reason) => done(`closed early: ${code} ${reason.toString()} (1008 usually means a rejected key)`));
  });
}
