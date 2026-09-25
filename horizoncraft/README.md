# HorizonCraft — world-builder agent

A long-running agent that takes natural-language requests ("add a dragon near the lake") from a web task board and, over hours, turns each one into a 3D asset placed in a walkable open world. Typed memory (asset ledger, landmarks, failures, GC'd knowledge) keeps it coherent across dozens of slow requests, and it resumes mid-request after a kill.

Sponsors: **Black Forest Labs FLUX** (text → image), **Liquid LFM2** (request parsing + context GC, local via Ollama), **Tinybird** (event stream + memory panel). 3D: **Hunyuan3D-2** (image → GLB, teammate's server).

```
ticket ──LFM2 parse──▶ FLUX image ──▶ Hunyuan GLB ──▶ placed in world (Three.js) ──▶ ticket closed with proof
          checkpoint      checkpoint      checkpoint        checkpoint + verify via /world.json
```

## Layout
| Path | What |
|---|---|
| `orchestrator/index.js` | The loop. `FAKE_PIPELINE=1` skips FLUX/Hunyuan and places a cube (test the loop + resume without keys). |
| `orchestrator/board.js` | Task board HTTP client. |
| `memory/` | `state.js` (typed state, atomic checkpoint, position picking), `gc.js` (LFM2 keep/drop → knowledge), `render.js` (prompt slice + token count), `handoff.js`, `liquid.js`, `events.js` (Tinybird). |
| `build/` | `bfl.js` (FLUX image + FLUX 3 video), `hunyuan.js` (image → GLB). Output in `build/out/` (served at `/assets/`). |
| `taskboard/` | Express + SQLite ticket board on :3100, with optional selfie upload (→ FLUX Kontext → your character in the world). Also serves `/world/` (viewer), `/world.json`, `/state.json`, `/assets/`. |
| `world/index.html` | Three.js first-person world; polls `/world.json`, loads GLBs, normalizes scale/origin. Has a lake at (30,-20). |
| `dashboard/index.html` | Memory panel: counters, stage per ticket, GC feed, context-size chart. Reads local state by default, Tinybird if given a token. |
| `tinybird/` | `events` datasource + 3 endpoints. |
| `scripts/` | `check-all.sh`, `start-taskboard.sh`, `smoke/*`. |
| `.attic/minecraft/` | Retired Minecraft/Mindcraft pieces (gitignored). |

## Run (Node 20: `export PATH="/opt/homebrew/opt/node@20/bin:$PATH"`)
```bash
cp .env.example .env            # BFL_API_KEY, HUNYUAN_URL, TINYBIRD_* ; Liquid is prefilled for Ollama
npm install && (cd taskboard && npm install)
ollama serve                    # LFM2.5-1.2B already pulled
scripts/start-taskboard.sh      # board http://localhost:3100  ·  world http://localhost:3100/world/
node orchestrator/index.js      # the agent (FAKE_PIPELINE=1 node orchestrator/index.js to dry-run)
open http://localhost:3100/dashboard/
scripts/check-all.sh
```
Demo: file a ticket on the board (phones need Railway or `ngrok http 3100`), watch the dashboard stages, walk to it in the world. Kill the agent mid-generation (Ctrl-C), restart: it logs `[resume] #N@stage` and continues from the saved stage.
