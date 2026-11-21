interface Medication { name: string; dose: string; schedule: string }
interface Patient {
  id: string; first_name: string; last_name: string; birth_date: string; phone: string; language: string; discharge_date: string | null;
  procedure_name: string; emergency_contact_name: string; emergency_contact_phone: string; consent_ai_call: boolean; active: boolean; medications: Medication[];
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const text = (id: string) => $<HTMLInputElement>(id).value.trim();
const listEl = $('list');
const msg = $('msg');
let editingId: string | undefined;

const say = (s: string, err = false) => { msg.textContent = s; msg.className = err ? 'err' : ''; };

async function api(path: string, method = 'GET', body?: unknown) {
  const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = data.error;
    // zod issues arrive as [{path, message}]
    throw new Error(Array.isArray(e) ? e.map((i: any) => `${i.path.join('.')}: ${i.message}`).join('; ') : String(e ?? res.statusText));
  }
  return data;
}

const parseMeds = (s: string): Medication[] =>
  s.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const [name = '', dose = '', schedule = ''] = l.split('|').map((x) => x.trim());
    return { name, dose, schedule };
  });
const showMeds = (m: Medication[]) => m.map((x) => [x.name, x.dose, x.schedule].join(' | ').replace(/( \| )+$/, '')).join('\n');

const FIELDS = ['first_name', 'last_name', 'birth_date', 'discharge_date', 'procedure_name', 'phone', 'language', 'emergency_contact_name', 'emergency_contact_phone'];

function fill(p?: Patient) {
  editingId = p?.id;
  for (const f of FIELDS) $<HTMLInputElement>(f).value = (p as any)?.[f] ?? (f === 'language' ? 'en-US' : '');
  $<HTMLTextAreaElement>('medications').value = p ? showMeds(p.medications) : '';
  $<HTMLInputElement>('consent_ai_call').checked = p?.consent_ai_call ?? false;
  $('formTitle').textContent = p ? `Edit ${p.first_name}` : 'New patient';
  $('deactivate').hidden = !p || !p.active;
  const link = $<HTMLAnchorElement>('callLink');
  link.hidden = !p || !p.active || !p.consent_ai_call;
  if (p) link.href = `/?patient=${encodeURIComponent(p.id)}`;
  say('');
}

async function refresh() {
  const patients: Patient[] = await api(`/api/patients${$<HTMLInputElement>('showAll').checked ? '?all=1' : ''}`);
  listEl.replaceChildren();
  for (const p of patients) {
    const tr = document.createElement('tr');
    if (!p.active) tr.className = 'off';
    for (const v of [`${p.first_name} ${p.last_name}`.trim(), p.birth_date, p.procedure_name, p.consent_ai_call ? 'yes' : 'no']) {
      const td = document.createElement('td');
      td.textContent = v;
      tr.append(td);
    }
    const td = document.createElement('td');
    const b = document.createElement('button');
    b.textContent = 'Edit';
    b.onclick = () => fill(p);
    td.append(b);
    tr.append(td);
    listEl.append(tr);
  }
}

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    ...Object.fromEntries(FIELDS.map((f) => [f, text(f)])),
    discharge_date: text('discharge_date') || null,
    consent_ai_call: $<HTMLInputElement>('consent_ai_call').checked,
    medications: parseMeds($<HTMLTextAreaElement>('medications').value),
  };
  try {
    const saved: Patient = await api(editingId ? `/api/patients/${encodeURIComponent(editingId)}` : '/api/patients', editingId ? 'PUT' : 'POST', body);
    await refresh();
    fill(saved);
    say('Saved.');
  } catch (err) {
    say(err instanceof Error ? err.message : String(err), true);
  }
});

$('deactivate').onclick = async () => {
  if (!editingId || !confirm('Deactivate this patient? Their past calls and alerts are kept.')) return;
  try {
    await api(`/api/patients/${encodeURIComponent(editingId)}`, 'DELETE');
    await refresh();
    fill();
    say('Deactivated.');
  } catch (err) {
    say(err instanceof Error ? err.message : String(err), true);
  }
};
$('new').onclick = () => fill();
$('showAll').onchange = () => void refresh();

fill();
refresh().catch((err) => say(err.message, true));
