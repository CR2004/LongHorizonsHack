import { board } from '../../orchestrator/board.js';
await board.reopen(1);
const t0 = Date.now();
const t = await board.commentAndClose(1, `smoke test ${new Date().toISOString()}`);
console.log(`RESULT status=${t.status} comments=${t.comments.length} roundtrip_ms=${Date.now() - t0}`);
await board.reopen(1);
