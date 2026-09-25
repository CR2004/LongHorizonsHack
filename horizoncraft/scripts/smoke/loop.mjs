// Runs the orchestrator in FAKE mode against the local board until ticket #1 closes, then kills it.
import { spawn } from 'child_process';
import { board } from '../../orchestrator/board.js';
import { rmSync } from 'fs';
rmSync('state/horizon.json', { force: true });
await board.reopen(1);
const t0 = Date.now();
const p = spawn(process.execPath, ['orchestrator/index.js'], { env: { ...process.env, FAKE_PIPELINE: '1' }, stdio: 'inherit' });
let ok = false;
for (let i = 0; i < 40 && !ok; i++) { await new Promise(r => setTimeout(r, 1500)); ok = (await board.get(1)).status === 'closed'; }
p.kill();
const w = await (await fetch('http://localhost:3100/world.json')).json();
console.log(`RESULT ticket1=${ok ? 'closed' : 'open'} assets_in_world=${w.assets.length} ms=${Date.now() - t0}`);
if (!ok) process.exit(1);
