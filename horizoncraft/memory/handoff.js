// World switch bookkeeping: board (web) <-> generation (FLUX/Hunyuan) <-> world (viewer).
import { logEvent } from './state.js';
import { emit } from './events.js';
export function switchTo(state, world, note = '') {
    state.counters.switches++;
    logEvent(state, 'switch', `${world}: ${note}`);
    emit(world, 'switch_in', { note });
}
