import AgoraRTC, { type IAgoraRTCClient, type IMicrophoneAudioTrack } from 'agora-rtc-sdk-ng';

interface StartResponse { agentId: string; appId: string; channel: string; agentUid: number; userUid: number; userToken: string }
interface CallEvent { ts: string; type: 'tool' | 'alert'; tool?: string; args?: unknown; result?: Record<string, unknown>; reason?: string; details?: string }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const startBtn = $<HTMLButtonElement>('start');
const stopBtn = $<HTMLButtonElement>('stop');
const statusEl = $('status');
const speakingEl = $('speaking');
const eventsEl = $('events');
const patientSel = $<HTMLSelectElement>('patient');

let client: IAgoraRTCClient | undefined;
let mic: IMicrophoneAudioTrack | undefined;
let feed: EventSource | undefined;
let agentId: string | undefined;

// textContent only: tool results can contain patient-supplied text
function log(kind: 'sys' | 'err' | 'tool' | 'alert', text: string, ts = new Date().toISOString()) {
  const li = document.createElement('li');
  li.className = kind;
  const t = document.createElement('time');
  t.textContent = new Date(ts).toLocaleTimeString();
  li.append(t, text);
  eventsEl.append(li);
  li.scrollIntoView({ block: 'nearest' });
}
const setStatus = (s: string) => (statusEl.textContent = s);
const setBusy = (inCall: boolean) => { startBtn.disabled = inCall; stopBtn.disabled = !inCall; };

function render(e: CallEvent) {
  if (e.type === 'alert') return log('alert', `NURSE ALERT (${e.reason}): ${e.details}`, e.ts);
  log('tool', `${e.tool}(${JSON.stringify(e.args)}) -> ${JSON.stringify(e.result)}`, e.ts);
}

async function post(path: string, body: unknown) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : JSON.stringify(data.error ?? res.statusText));
  return data;
}

async function start() {
  setBusy(true);
  eventsEl.replaceChildren();
  try {
    setStatus('Starting agent...');
    const channel = `checkin-${Math.random().toString(36).slice(2, 8)}`;
    // open the feed first so no early tool event is missed
    feed = new EventSource(`/api/calls/${channel}/events`);
    feed.onmessage = (m) => render(JSON.parse(m.data));

    const s: StartResponse = await post('/api/agent/start', { channel, patientId: patientSel.value });
    agentId = s.agentId;
    log('sys', `Agent ${s.agentId} started on channel ${s.channel}`);

    const rtc = (client = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' }));
    rtc.on('user-published', async (user, mediaType) => {
      await rtc.subscribe(user, mediaType);
      if (mediaType === 'audio') { user.audioTrack?.play(); log('sys', 'Agent audio connected'); }
    });
    rtc.on('user-left', () => log('sys', 'Agent left the channel'));
    rtc.enableAudioVolumeIndicator();
    rtc.on('volume-indicator', (vols) => {
      const agent = vols.find((v) => v.uid === s.agentUid);
      speakingEl.textContent = agent && agent.level > 5 ? 'Agent speaking...' : '';
    });

    setStatus('Joining channel...');
    await rtc.join(s.appId, s.channel, s.userToken, s.userUid);
    const track = (mic = await AgoraRTC.createMicrophoneAudioTrack({ AEC: true, ANS: true, AGC: true }));
    await rtc.publish(track);
    setStatus('In call: speak when the agent greets you');
  } catch (e) {
    log('err', e instanceof Error ? e.message : String(e));
    await stop('Failed to start');
  }
}

async function stop(finalStatus = 'Idle') {
  feed?.close();
  mic?.close();
  await client?.leave().catch(() => {});
  if (agentId) await post('/api/agent/stop', { agentId }).catch((e) => log('err', `stop failed: ${e.message}`));
  client = mic = feed = agentId = undefined;
  speakingEl.textContent = '';
  setStatus(finalStatus);
  setBusy(false);
}

// Only patients who consented can be called (the server enforces this too).
async function loadPatients() {
  try {
    const all: { id: string; first_name: string; last_name: string; consent_ai_call: boolean }[] = await (await fetch('/api/patients')).json();
    const callable = all.filter((p) => p.consent_ai_call);
    for (const p of callable) patientSel.add(new Option(`${p.first_name} ${p.last_name}`.trim(), p.id));
    const wanted = new URLSearchParams(location.search).get('patient');
    if (wanted && callable.some((p) => p.id === wanted)) patientSel.value = wanted;
    if (!callable.length) { startBtn.disabled = true; log('err', 'No patient has consented to AI check-in calls. Add one on the Patients page.'); }
  } catch (e) {
    startBtn.disabled = true;
    log('err', `Could not load patients: ${e instanceof Error ? e.message : e}`);
  }
}
void loadPatients();

startBtn.onclick = start;
stopBtn.onclick = () => stop('Call ended');
// Best effort so closing the tab does not leave a billed agent running (idle_timeout is the backstop).
addEventListener('pagehide', () => {
  if (agentId) navigator.sendBeacon('/api/agent/stop', new Blob([JSON.stringify({ agentId })], { type: 'application/json' }));
});
