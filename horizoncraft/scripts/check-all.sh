#!/usr/bin/env bash
# HorizonCraft smoke checks. Prints PASS/FAIL per check. Assumes server + taskboard deploy are up.
# WITH_VIDEO=1 adds the FLUX 3 video check.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="/opt/homebrew/opt/node@20/bin:/opt/homebrew/opt/openjdk@21/bin:$PATH"
cd "$ROOT"; set -a; [ -f .env ] && . ./.env; set +a
# gpt-5-mini $/1M tokens (in, out) — verify on openai.com/api/pricing before trusting cost
PRICE_IN="${PRICE_IN:-0.25}"; PRICE_OUT="${PRICE_OUT:-2.00}"
pass=0; fail=0
report() { if [ "$2" = 0 ]; then echo "PASS  $1  $3"; pass=$((pass+1)); else echo "FAIL  $1  $3"; fail=$((fail+1)); fi; }
run() { local name="$1"; shift; local out; out=$("$@" 2>&1); local rc=$?; report "$name" $rc "$(echo "$out" | grep RESULT | tail -1 | sed 's/^RESULT //')"; [ $rc = 0 ] || echo "$out" | tail -5 | sed 's/^/      /'; }

# 1. versions
nv=$(node -v)
[[ "$nv" == v20.* ]]; report "1 node" $? "$nv"

# 2. task board + world viewer
curl -sf -o /dev/null http://localhost:3100/healthz; report "2 taskboard :3100" $? "(scripts/start-taskboard.sh)"
curl -sf http://localhost:3100/world/ | grep -q importmap; report "2 world viewer" $? "http://localhost:3100/world/"
# 3. ollama + lfm2
curl -sf http://localhost:11434/api/tags | grep -q LFM2; report "3 ollama LFM2" $? ""
run "4 liquid classify" node scripts/smoke/liquid.mjs
run "5 board http" node scripts/smoke/board.mjs
run "6 loop (fake pipeline, 1 ticket)" env FAKE_PIPELINE=1 node scripts/smoke/loop.mjs
run "7 bfl image" node scripts/smoke/bfl.mjs
[ -n "${WITH_VIDEO:-}" ] && run "7b bfl video" node scripts/smoke/bfl-video.mjs
run "8 hunyuan" node scripts/smoke/hunyuan.mjs
run "8b nimble live" node scripts/smoke/nimble-live.mjs
run "9 tinybird" node scripts/smoke/tinybird.mjs
echo "10 dashboard: open dashboard/index.html (reads local state; add ?host=&token= for Tinybird)"
echo "---- $pass passed, $fail failed"
