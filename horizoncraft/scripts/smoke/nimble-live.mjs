import { loadState, saveState } from '../../memory/state.js';
import { tick } from '../../orchestrator/live.js';
const state = loadState();
await tick(state, { save: () => saveState(state) });
const w = state.live?.weather?.value;
console.log(`RESULT weather="${w}" real_condition=${state.live?.real_condition} local_time=${state.live?.local_time} night=${state.live?.is_night_real}`);
if (!w) process.exit(1);
