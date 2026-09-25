import { classify } from '../../memory/liquid.js';
const obs = 'Collected 3 oak_log. Inventory: oak_log x3, wooden_axe x1. Nearby: grass_block, dirt, oak_leaves, birch_log.';
const r = await classify(obs, 'Ticket #1: Collect 10 oak logs');
console.log(JSON.stringify(r));
console.log(`RESULT op=${r.op} latency_ms=${r.latencyMs}`);
