# Post-Discharge Check-In Voice Agent (MVP)

24-hour post-discharge call: verify identity, log medication, screen for red flags, escalate to a nurse.
Agora Conversational AI Engine (voice pipeline + tool calls) + Murf Falcon TTS. Test data only, **not safe for real PHI yet** (see the checklist at the bottom).

```
Browser (Agora RTC)  <->  Agora channel  <->  Agora ConvoAI agent (ASR -> LLM -> Murf TTS)
                                                   |  tool calls (HTTPS POST + X-Webhook-Secret)
                                                   v
                              this server: /webhooks/*  ->  SQLite  ->  nurse alert log + live feed
```

## 0. Prerequisites
- Node **24+** (uses built-in `node:sqlite`; developed on Node 26).
- Accounts/keys: Murf API key; Agora project (App ID + App Certificate) and RESTful Customer ID/Secret; an OpenAI-compatible LLM key; `ngrok` (or any public HTTPS tunnel).

## 1. Install and configure
```bash
npm install
cp .env.example .env        # then fill it in
openssl rand -hex 24        # paste as WEBHOOK_SECRET
```
Fill in `MURF_API_KEY`, `AGORA_*`, `LLM_API_KEY`, `WEBHOOK_SECRET`. Leave `PUBLIC_BASE_URL` for step 5.

## 2. Verify Murf first (no Agora needed)
```bash
npm run murf:smoke
```
Expect `"ok": true`, `audioBytes` > 0 and `msToFirstAudio` of a few hundred ms. If it fails:
- `closed early: 1008` or `HTTP 403` → bad key.
- `INVALID_VOICE` → set `MURF_VOICE_ID` to a Falcon voice from Murf's voice library.
- Rate or model errors → adjust `MURF_RATE` / `MURF_MODEL`.

Model string: Murf's own docs use `falcon-2.1`, Agora's sample uses `FALCON`. The smoke check validates `MURF_MODEL` against Murf directly. If Agora rejects it later, try `MURF_MODEL=FALCON`.

## 3. Start the server and check Murf over HTTP
```bash
npm run dev                                  # builds the browser client, then starts on :3000
```
```bash
curl -s localhost:3000/health
curl -s localhost:3000/api/murf-test
```

## 4. Verify the tool webhooks (no Agora needed)
Automated, 14 checks (auth, verification lockout, no meds before verification, red-flag rules, idempotent replay, exactly one alert, validation):
```bash
npm run verify
```
Expect `ALL PASSED`. If you started the server with a custom `DB_PATH` / `NURSE_ALERT_LOG`, export the same values when running it.

Manual equivalents. Register a call (the Agora start does this normally), then call the tools:
```bash
npm run call:register -- demo-call
SECRET=$(grep '^WEBHOOK_SECRET=' .env | cut -d= -f2)
```
```bash
# 401: wrong secret
curl -s -w ' [%{http_code}]\n' -X POST localhost:3000/webhooks/verify-patient -H 'Content-Type: application/json' -H 'X-Webhook-Secret: nope' -d '{"call_id":"demo-call","tool_call_id":"t1","birth_month":3,"birth_day":14}'
```
```bash
# verify identity (demo patient was born March 14): returns first name and medications
curl -s -X POST localhost:3000/webhooks/verify-patient -H 'Content-Type: application/json' -H "X-Webhook-Secret: $SECRET" -d '{"call_id":"demo-call","tool_call_id":"t2","birth_month":3,"birth_day":14}'
```
```bash
# log medication status
curl -s -X POST localhost:3000/webhooks/log-medication -H 'Content-Type: application/json' -H "X-Webhook-Secret: $SECRET" -d '{"call_id":"demo-call","tool_call_id":"t3","prescriptions_picked_up":true,"dose_taken_today":false}'
```
```bash
# symptom triage with a red flag (pain >= 7, fever, or swelling): alert is raised by the server itself
curl -s -X POST localhost:3000/webhooks/symptom-triage -H 'Content-Type: application/json' -H "X-Webhook-Secret: $SECRET" -d '{"call_id":"demo-call","tool_call_id":"t4","fever":false,"unusual_swelling":false,"pain_score":8}'
```
```bash
# escalate: returns the fixed nurse follow-up message (does not create a second alert for the same reason)
curl -s -X POST localhost:3000/webhooks/escalate-to-nurse -H 'Content-Type: application/json' -H "X-Webhook-Secret: $SECRET" -d '{"call_id":"demo-call","tool_call_id":"t5","reason":"red_flag_symptoms","details":"pain 8"}'
```
```bash
# idempotency: repeat the exact tool_call_id from the verify step; same response, nothing changes
curl -s -X POST localhost:3000/webhooks/verify-patient -H 'Content-Type: application/json' -H "X-Webhook-Secret: $SECRET" -d '{"call_id":"demo-call","tool_call_id":"t2","birth_month":3,"birth_day":14}'
```
```bash
# nurse alert log (also printed to the server console as [NURSE ALERT])
cat data/nurse-alerts.log
```

## 5. Real call
1. Public tunnel to the server: `ngrok http 3000`. Put the `https://...` URL in `.env` as `PUBLIC_BASE_URL` and restart `npm run dev`. Agora's engine calls the webhooks from the internet, so this must be public HTTPS.
2. Optional: start an agent from curl first, to check Agora credentials, the Murf params and the tool definitions.
   ```bash
   curl -s -X POST localhost:3000/api/agent/start -H 'Content-Type: application/json' -d '{}'
   # copy agentId from the response, then:
   curl -s -X POST localhost:3000/api/agent/stop -H 'Content-Type: application/json' -d '{"agentId":"PASTE_AGENT_ID"}'
   ```
3. Open `http://localhost:3000`, click **Start Check-In Call**, allow the mic.
4. Happy path: "March 14" → "yes, picked up" / "yes, took it" → "no fever, no swelling, pain is a 3" → agent closes.
5. Red-flag path: same, but "pain is an 8" (or "I have a fever"). Expect an on-screen **NURSE ALERT**, a line in `data/nurse-alerts.log`, and the agent saying a nurse will follow up and to seek urgent care if symptoms worsen.
6. Guardrail path: ask "should I double my dose?" Expect no advice, an escalation, and the nurse message.
7. Wrong birth date twice: the agent should end the call politely without sharing any health detail.

## 6. Deploy to Render (public HTTPS, replaces ngrok)
Use this if you can't run a tunnel (for example a corporate proxy blocks ngrok). Render gives the app a stable `https://….onrender.com` address, and the app uses it automatically (`RENDER_EXTERNAL_URL`), so you don't set `PUBLIC_BASE_URL`.

1. **Put the code on GitHub** (keep `.env` out; `.gitignore` already excludes `.env`, `data/`, `node_modules/` and the built client):
   ```bash
   git init
   git add -A
   git status --short        # confirm .env is NOT in this list
   git commit -m "Check-in voice agent"
   ```
   Then create an empty private repo on GitHub and push to it (GitHub shows the exact two commands).
2. In [Render](https://render.com/): **New → Blueprint**, pick that repo. Render reads [render.yaml](render.yaml).
3. Render asks for the secret values. Paste from your `.env`: `LLM_API_KEY`, `MURF_API_KEY`, `AGORA_APP_ID`, `AGORA_APP_CERTIFICATE`, `AGORA_CUSTOMER_ID`, `AGORA_CUSTOMER_SECRET`. `WEBHOOK_SECRET` and `BASIC_AUTH_PASS` are generated for you.
4. Deploy. When it's live, open the service's **Environment** tab and copy `BASIC_AUTH_PASS`. The username is `admin`.
5. Check it:
   ```bash
   curl -s https://YOUR-SERVICE.onrender.com/health
   curl -s -u admin:YOUR_BASIC_AUTH_PASS https://YOUR-SERVICE.onrender.com/api/murf-test
   curl -s -o /dev/null -w '%{http_code}\n' https://YOUR-SERVICE.onrender.com/api/murf-test   # expect 401 without the login
   ```
6. Open `https://YOUR-SERVICE.onrender.com` in a browser, sign in, and run the call as in step 5 above.

Notes:
- The free plan sleeps after about 15 minutes idle. Hit `/health` and wait for the reply before a test call, or Agora's first tool call can time out.
- The free plan also wipes the SQLite file and alert log on every restart or deploy. That's fine for demo data and not for anything you need to keep.
- Webhooks use only the secret header, not the login, because Agora's servers can't type a password. The login covers the page and `/api/*`.
- `BASIC_AUTH_PASS` is required on Render. The app refuses to start without it.

## Troubleshooting
| Symptom | Likely cause |
|---|---|
| `/api/agent/start` → Agora 401 | Wrong `AGORA_CUSTOMER_ID` / `AGORA_CUSTOMER_SECRET` (these are the RESTful API credentials, not the App ID/Certificate). |
| Agora 400 on tools | `PUBLIC_BASE_URL` is not `https://`, or a tool name contains an underscore. |
| Agent talks but tools never fire | Webhook not reachable (tunnel down/URL changed), or `WEBHOOK_SECRET` mismatch (check the server log for 401s). |
| Tool result `UnresolvedTemplate` | The model omitted a required argument; every tool parameter is required by design. |
| Agent silent | Check `npm run murf:smoke`; confirm the Murf params, and that you spoke after joining. |
| No mic | Browser permission denied; `localhost` is allowed over http, other hosts need https. |

## What is verified vs not
- Verified locally: Murf WebSocket synthesis, webhook auth/rules/idempotency/alert log, SSE feed, browser page loads and shows errors.
- **Not yet verified:** an end-to-end call (Agora `/join` with these exact params, Murf inside Agora, tool calls from Agora, microphone audio). Treat the first real call as the integration test.

---

# Before this handles real PHI: hardening checklist

Do not use real patient data until every **Blocker** is done.

### Blockers
- [ ] **BAAs / data-processing agreements** with every vendor that sees PHI: Agora (audio), Murf (text of every spoken sentence), the LLM provider (full transcript), your host, any tunnel/proxy, log/monitoring vendors. If a vendor will not sign, it cannot be in the path. Confirm the applicable law with compliance (HIPAA for US patients; India's DPDP Act, GDPR, etc. elsewhere).
- [ ] **Real auth on `/api/*`.** The page and `/api/*` sit behind one shared Basic Auth password (`BASIC_AUTH_PASS`), with no lockout or rate limit, and `start` still accepts any `patientId`. Require authenticated staff or a signed, single-use, patient-bound call token. The live feed `/api/calls/:id/events` shows medication names.
- [ ] **Stronger identity verification.** Birth month and day are guessable (365 combos) and the 2-attempt lockout is per *call*, so starting a new call resets it. Lock per patient, add a second factor, and rate-limit starts. Do not return medication names to the model until the stronger check passes.
- [ ] **Webhook auth.** Today it is one static shared secret in the `X-Webhook-Secret` header (Agora tool headers are static). Rotate it, store it in a secrets manager, add rate limiting and, if possible, IP allow-listing for Agora's egress or a signed-request scheme. Never log the header.
- [ ] **Encryption.** TLS everywhere (including the tunnel replacement: a real domain and cert). Encrypt data at rest (managed Postgres with KMS-backed disk encryption, or SQLCipher). Encrypt backups.
- [ ] **Production database.** Replace SQLite and the seeded fictional patient: Postgres, migrations, backups, retention and deletion policy, least-privilege DB user, real patient lookup from your EHR/roster.
- [ ] **No PHI in logs.** The alert log stores free-text `details`, the console prints alerts, and the live feed carries tool results. Redact or tokenize, restrict access, set retention. Remove the in-memory event history or move it behind auth.
- [ ] **Secrets.** `MURF_API_KEY` and `LLM_API_KEY` are sent to Agora in each `/join` body; confirm Agora's handling, use scoped keys, rotate. Rotate any key that has ever been pasted into chat or a ticket (the Murf key used during development was).

### Clinical safety
- [ ] Clinician sign-off on the system prompt, the red-flag rules (pain >= 7, fever, swelling) and the fixed nurse message. Add emergency wording for chest pain, breathing trouble and severe bleeding.
- [ ] **Alert delivery with an SLA.** A JSONL file is not a nurse queue. Route alerts to a monitored channel (pager/SMS/EHR task) with acknowledgement, escalation if unacknowledged, and a fallback if delivery fails.
- [ ] **Eval the model, not just the code.** Red-flag triage is enforced server-side, but "patient asked a clinical question" escalation and "never give advice" depend on the LLM. Build a test set (including adversarial and noisy-ASR phrasings) and run it on every prompt or model change. Failed ASR or silence needs a defined fallback (callback or nurse alert).
- [ ] Call-recording and AI-disclosure consent, language support, accessibility, and what happens on voicemail or a wrong-person answer.

### Operations
- [ ] Audit trail of who accessed which call; monitoring and alerting on webhook errors, Agora/Murf failures and agent start failures.
- [ ] Idle and max-duration limits, cleanup of orphaned agents (the 120 s idle timeout is the only backstop today), cost controls.
- [ ] Dependency and vulnerability scanning; pin versions; CI running `npm run typecheck`, `npm test` and `npm run verify`.
- [ ] Data-retention settings at Agora, Murf and the LLM provider (prefer zero or minimal retention); data-residency requirements (Murf supports regional endpoints).
