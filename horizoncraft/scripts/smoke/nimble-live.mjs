import { loadState, saveState } from '../../memory/state.js';
import { tick } from '../../orchestrator/live.js';
const state = loadState();
await tick(state, { save: () => saveState(state) });
const w = state.live?.weather?.value, h = state.live?.headline?.value;
console.log(`RESULT weather="${w}" condition=${state.live?.condition} headline="${h}"`);
if (!w && !h) process.exit(1);
