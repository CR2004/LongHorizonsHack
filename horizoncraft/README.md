# HorizonCraft

**A personal world builder.** You talk to an agent about your life; it builds a small 3D world that mirrors the conversation, keeps it alive for hours, and remembers you.

> "I'm heading to Lake Tahoe this weekend to ski with my brother"

Within seconds the agent replies, remembers that you ski, points the sky at Tahoe's real weather and local time (night there means stars here), and starts building a ski chalet by the lake. A minute or two later it's standing in the world.

Built in one day at the **Long Horizon Agents Hackathon** (tokens&, San Francisco). The theme: agents that stay reliable over long tasks. The pretty world is the demo; the memory underneath is the point.

## What makes it long-horizon

- **Typed state instead of a transcript.** The agent never re-reads the conversation. Every prompt is rendered from a small, bounded state: things in the world with coordinates, landmarks, what it knows about you, live conditions. Turn 100 costs the same as turn 1.
- **Checkpoint and resume.** Every stage of every build is checkpointed atomically. Kill the agent mid-generation, restart it, and it continues from the exact stage it died in without repaying for earlier steps.
- **Memory changes behavior.** Landmarks let "put the dragon north of the chalet" work an hour after the chalet was built. Personal facts shape what gets built. Rejecting a thing ("remake the dragon") writes to a failures ledger, and the regeneration uses a new seed and a "different design" note.
- **Live data with clear precedence.** The sky follows the real weather and time of day of the place you're talking about. Your explicit requests ("make it snow", "make it night") override it until you say "reset weather". The agent is not allowed to change the weather on its own.

## How it works

```
chat message
   │
   ├─ command? ("make it snow", "remake X") ──▶ applied instantly
   │
   └─ interpreter (gpt-5-mini, JSON mode) ◀── world state + personal memory in the prompt
         │  {reply, actions}
         ├─ reply posted to chat immediately
         ├─ remember · live_weather · weather · move · point · remake · remove ──▶ state
         └─ build ──▶ FLUX image ──▶ Hunyuan3D mesh ──▶ placed ──▶ verified ──▶ closed
                        checkpoint      checkpoint       checkpoint
```

One process (`orchestrator/index.js`) polls the board every 5 s, takes the oldest open request, and runs it through the above. State lives in `state/horizon.json`. The viewer polls `/world.json` every 3 s.

### Stack

| Piece | Tool | Role |
|---|---|---|
| Interpreter | OpenAI `gpt-5-mini` | Conversation → `{reply, actions}`. The only model that needs to be smart. |
| Fast decisions | **Liquid LFM2.5-1.2B** (local, via Ollama) | Naming, sizing, keep/drop on observations. ~0.5 s per call, no network. |
| Live web | **Nimble** | Fetches real weather, temperature, local time, sunrise/sunset for any place. |
| Images | **Black Forest Labs FLUX** | Text → image; FLUX Kontext turns a selfie into a game character. |
| 3D | Hunyuan3D-2 via **fal.ai** | Image → GLB mesh (40–110 s). Local `api_server.py` supported as a fallback. |
| Analytics | **Rawtree** | Every decision, checkpoint and token count streamed in; the memory panel reads it back. |
| World | Three.js | First-person viewer with weather, day/night, compass, discovery score. |
| Board | Express + SQLite | Requests and replies; the chat is a view over it. |

Anything that must be exact (the FLUX prompt, landmark matching, weather parsing, positions) is done in code, not left to the small model.

## Run it

Requirements: Node 20, [Ollama](https://ollama.com), and API keys for OpenAI, BFL, fal.ai, Nimble and Rawtree (Nimble and Rawtree are optional; without them the sky stays clear and the memory panel reads local state).

```bash
cp .env.example .env          # fill in the keys
npm install && (cd taskboard && npm install)
ollama pull hf.co/LiquidAI/LFM2.5-1.2B-Instruct-GGUF:Q8_0
ollama serve                  # terminal 1
scripts/start-taskboard.sh    # terminal 2 → http://localhost:3100/world/
node orchestrator/index.js    # terminal 3 → the agent
```

Open http://localhost:3100/world/ and start talking. The memory panel is at http://localhost:3100/dashboard/.

- Dry run without any paid API: `FAKE_PIPELINE=1 FAKE_DELAY_MS=8000 node orchestrator/index.js` places cubes but exercises the whole loop, including resume.
- Smoke tests for every integration: `scripts/check-all.sh`.
- Re-run a request from a given stage (e.g. after an ugly mesh): `node scripts/redo.mjs <ticket> [parsed|image|mesh]`. Stop the agent first; it holds state in memory.
- Phones: `ngrok http 3100` and share the HTTPS link. Geolocated weather needs HTTPS.

### Things to try in the chat

- `I'm planning on going to Rome next month` — night sky and stars if it's night in Rome; a Roman landmark appears.
- `make it snow` · `make it night` · `reset weather`
- `put the dragon north of the colosseum` · `move the dragon away from the lake` · `where is the chalet?` (compass locks on)
- `remake the dragon` — or walk up to it and press **X**
- Attach a photo and say `this is me, Sam` — you appear in the world as a low-poly character. The photo stays on your machine except for the one FLUX Kontext call.

In the world: WASD to move, E to discover things (score), X to remake, Backspace to remove, Esc to get back to the chat.

## Layout

| Path | What |
|---|---|
| `orchestrator/index.js` | The loop: polling, command parsing, action handlers, build pipeline, resume. |
| `orchestrator/interpret.js` | The interpreter prompt and call. |
| `orchestrator/live.js` | Nimble weather fetch and parse; day/night from local time. |
| `orchestrator/board.js` | HTTP client for the board. |
| `memory/state.js` | Typed state, atomic save/load, position picking. |
| `memory/render.js` | Renders the state slice that goes into prompts. |
| `memory/gc.js`, `memory/liquid.js` | Keep/drop decisions and LFM2 client. |
| `memory/events.js` | Rawtree ingest and the SQL behind the memory panel. |
| `build/bfl.js`, `build/fal3d.js`, `build/hunyuan.js` | FLUX, fal.ai and local Hunyuan clients. Outputs land in `build/out/`. |
| `taskboard/server.js` | Board, chat API, `/world.json`, `/state.json`, analytics proxy, static viewer and panel. |
| `world/index.html` | The Three.js world. |
| `dashboard/index.html` | The memory panel. |
| `scripts/` | Start script, smoke tests, `redo.mjs`, `check-all.sh`. |

## Honest limits

- One agent, no planning across requests. Each message is interpreted on its own, with the state as context. Compound requests are split into follow-up builds, which is the closest thing to a plan.
- LFM2 at 1.2B is reliable for JSON and fast, not for judgment. It is deliberately kept away from anything that must be exact.
- Meshes are untextured (fal's textured variants return formats the viewer doesn't consume); each thing gets a per-item color.
- Generation is slow (1–2 min per thing) and costs a few cents per request across the APIs.

## License

MIT
