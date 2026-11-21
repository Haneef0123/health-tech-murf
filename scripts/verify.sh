#!/usr/bin/env bash
# Exercises the tool webhooks against a RUNNING local server (npm run dev). No Agora credentials needed.
# Usage: npm run verify        (BASE=http://localhost:3000 by default; set BASIC_AUTH_PASS too if the server has a login)
# Run the server and this script with the same NURSE_ALERT_LOG if you override it.
# Note: this writes test calls and alerts into whatever database the server uses; point the server at a throwaway database.
set -u
cd "$(dirname "$0")/.."
BASE=${BASE:-http://localhost:3000}
SECRET=$(grep '^WEBHOOK_SECRET=' .env | cut -d= -f2)
ALERT_LOG=${NURSE_ALERT_LOG:-data/nurse-alerts.log}
A=lockout-$(date +%s)   # call that fails verification
B=happy-$(date +%s)     # call that verifies, then trips a red flag
fail=0

post() { # path json [secret]
  curl -s -w ' [%{http_code}]' -X POST "$BASE/webhooks/$1" \
    -H 'Content-Type: application/json' -H "X-Webhook-Secret: ${3-$SECRET}" -d "$2"
}
tc() { echo "$1-$RANDOM$RANDOM"; }  # unique tool_call_id per request (used inside $(), so no counter)
alerts_for() { cat "$ALERT_LOG" 2>/dev/null | grep -c "$1"; }
check() { # name expected-substring actual
  if [[ "$3" == *"$2"* ]]; then echo "PASS  $1"; else echo "FAIL  $1"; echo "      expected: $2"; echo "      got:      $3"; fail=1; fi
}

AUTH=(); [ -n "${BASIC_AUTH_PASS:-}" ] && AUTH=(-u "${BASIC_AUTH_USER:-admin}:$BASIC_AUTH_PASS")
register() { curl -s ${AUTH[@]+"${AUTH[@]}"} -X POST "$BASE/api/dev/register-call" -H 'Content-Type: application/json' -d '{"call_id":"'$1'"}'; }
check "register call A" '"ok":true' "$(register "$A")"
check "register call B" '"ok":true' "$(register "$B")"

check "wrong secret is rejected"        "[401]"                 "$(post verify-patient '{"call_id":"'$A'","tool_call_id":"x","birth_month":3,"birth_day":14}' wrong)"
check "no meds before verification"     "not_verified"          "$(post log-medication '{"call_id":"'$A'","tool_call_id":"'$(tc $A)'","prescriptions_picked_up":true,"dose_taken_today":true}')"
check "wrong birth date 1st attempt"    '"verified":false'      "$(post verify-patient '{"call_id":"'$A'","tool_call_id":"'$(tc $A)'","birth_month":1,"birth_day":1}')"
check "wrong birth date 2nd => locked"  '"locked":true'         "$(post verify-patient '{"call_id":"'$A'","tool_call_id":"'$(tc $A)'","birth_month":2,"birth_day":2}')"
check "right answer after lock stays locked" '"locked":true'    "$(post verify-patient '{"call_id":"'$A'","tool_call_id":"'$(tc $A)'","birth_month":3,"birth_day":14}')"

check "verify (call B)"                 '"verified":true'       "$(post verify-patient '{"call_id":"'$B'","tool_call_id":"'$(tc $B)'","birth_month":3,"birth_day":14}')"
check "log medication"                  '"ok":true'             "$(post log-medication '{"call_id":"'$B'","tool_call_id":"'$(tc $B)'","prescriptions_picked_up":true,"dose_taken_today":true}')"
check "pain 3, no fever => no red flag" '"red_flag":false'      "$(post symptom-triage '{"call_id":"'$B'","tool_call_id":"'$(tc $B)'","fever":false,"unusual_swelling":false,"pain_score":3}')"
check "no alert logged yet"             "0"                     "$(alerts_for "$B")"
RED="$(tc $B)"
check "fever => red flag"               '"red_flag":true'       "$(post symptom-triage '{"call_id":"'$B'","tool_call_id":"'$RED'","fever":true,"unusual_swelling":false,"pain_score":3}')"
check "replay same tool_call_id"        '"red_flag":true'       "$(post symptom-triage '{"call_id":"'$B'","tool_call_id":"'$RED'","fever":true,"unusual_swelling":false,"pain_score":3}')"
check "escalate returns nurse message"  'nurse will follow up'  "$(post escalate-to-nurse '{"call_id":"'$B'","tool_call_id":"'$(tc $B)'","reason":"red_flag_symptoms","details":"fever"}')"
check "exactly one alert for call B"    "1"                     "$(alerts_for "$B")"
check "invalid args => 400"             "[400]"                 "$(post verify-patient '{"call_id":"'$B'","tool_call_id":"'$(tc $B)'","birth_month":13,"birth_day":1}')"

[[ $fail == 0 ]] && echo "ALL PASSED" || { echo "SOME FAILED"; exit 1; }
