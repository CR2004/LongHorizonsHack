// Context GC: observations (API responses, logs) -> one fact or nothing. Raw text never enters state.
import { classify } from './liquid.js';
import { logEvent } from './state.js';
import { emit } from './events.js';

const NOISE = /^\s*$|^\[?(GIN|INFO|DEBUG)\b|progress|polling|Pending|^(flux|hunyuan|fal3d|parsed request) /i;   // pipeline status lines: facts already in the checkpoint

export async function collect(state, observation, { currentGoal, source = 'system' } = {}) {
    const text = typeof observation === 'string' ? observation : JSON.stringify(observation);
    let d;
    if (NOISE.test(text.slice(0, 80))) d = { op: 'drop', slot: 'none', content: '', reason: 'pipeline status, already in checkpoint', latencyMs: 0 };
    else {
        try { d = await classify(text, currentGoal); }
        catch (e) { d = { op: 'drop', slot: 'none', content: '', reason: `lfm2 error: ${e.message.slice(0, 60)}`, latencyMs: 0 }; }
    }
    if (d.op !== 'drop' && d.content) {
        state.knowledge.push({ fact: d.content, source, ts: new Date().toISOString() });
        if (state.knowledge.length > 100) state.knowledge.shift();
        state.counters.gc_kept++;
    } else state.counters.gc_dropped++;
    logEvent(state, 'gc_decision', `${d.op}: ${d.reason}`);
    emit('system', 'gc_decision', { op: d.op, slot: d.slot, reason: d.reason, bytes_in: text.length, bytes_kept: (d.content || '').length, latency_ms: d.latencyMs });
    return d;
}
export { classify };
