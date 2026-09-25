import { makeEvent, sendEvents, queryPipe } from '../../memory/events.js';
const run = `smoke-${Date.now()}`;
process.env.RUN_ID = run;
const types = ['command', 'result', 'switch_out', 'switch_in', 'gc_decision', 'ticket_update', 'checkpoint', 'resume', 'gc_decision', 'command'];
const evs = types.map((t, i) => makeEvent(i % 2 ? 'minecraft' : 'browser', t,
    t === 'gc_decision' ? { op: i === 4 ? 'keep' : 'drop', slot: 'inventory', reason: 'smoke' }
  : t === 'ticket_update' ? { id: 1, status: 'done_verified' }
  : t === 'checkpoint' ? { goal_stack: [{ goal: 'Collect 10 oak logs' }, { goal: 'find a tree' }] } : { i },
    1000 + i * 10));
await sendEvents(evs, { wait: true });
let rows = [];
for (let i = 0; i < 10 && rows.length < 10; i++) {           // endpoint may lag a moment
    rows = await queryPipe('recent_events', { run_id: run, limit: 20 });
    if (rows.length < 10) await new Promise(r => setTimeout(r, 1500));
}
console.log(`RESULT run_id=${run} sent=10 read_back=${rows.length}`);
if (rows.length < 10) process.exit(1);
