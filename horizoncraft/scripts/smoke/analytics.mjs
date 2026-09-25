import { makeEvent, sendEvents, queryPipe } from '../../memory/events.js';
const run = `smoke-${Date.now()}`; process.env.RUN_ID = run;
const types = ['command', 'result', 'switch_out', 'switch_in', 'gc_decision', 'ticket_update', 'checkpoint', 'resume', 'gc_decision', 'command'];
const evs = types.map((t, i) => makeEvent(i % 2 ? 'world' : 'board', t,
    t === 'gc_decision' ? { op: i === 4 ? 'keep' : 'drop', reason: 'smoke' } : t === 'ticket_update' ? { id: 1, status: 'done_verified' } : { i }, 1000 + i * 10));
const ins = await sendEvents(evs);
let rows = [];
for (let i = 0; i < 6 && rows.length < 10; i++) { rows = await queryPipe('recent_events', { run_id: run, limit: 20 }); if (rows.length < 10) await new Promise(r => setTimeout(r, 1500)); }
const c = (await queryPipe('counters', { run_id: run }))[0];
console.log(`RESULT inserted=${JSON.stringify(ins)} read_back=${rows.length} counters=${JSON.stringify(c)}`);
if (rows.length < 10) process.exit(1);
