// Typed agent state + atomic checkpoint. One JSON file; the world viewer reads it too (/world.json).
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'fs';
import path from 'path';

export const STAGES = ['queued', 'parsed', 'image', 'mesh', 'placed'];   // per-asset pipeline stages (checkpoint after each)

export function emptyState() {
    return {
        version: 2,
        tickets: {},      // id -> { id, title, status: todo|in_progress|done_verified|failed, reason? }
        assets: {},       // ticket_id -> { id, ticket_id, name, prompt, stage, image?, glb?, url?, x, z, size, rotation, status, views? }
        landmarks: { lake: { x: 30, z: -20, note: 'blue circle, exists from the start' } },   // name -> { x, z, note }
        knowledge: [],    // [{ fact, source, ts }]
        failures: [],     // [{ ticket_id, stage, reason, ts }]
        event_log: [],    // [{ n, ts, type, summary }] last 50
        counters: { switches: 0, tickets_closed: 0, resumes: 0, gc_kept: 0, gc_dropped: 0 },
        context_history: [], // render().tokens after each checkpoint (dashboard chart)
        seq: 0,
    };
}
export const statePath = (name = 'horizon') => path.resolve('state', `${name}.json`);
export function loadState(file = statePath()) {
    if (!existsSync(file)) return emptyState();
    return { ...emptyState(), ...JSON.parse(readFileSync(file, 'utf8')) };
}
export function saveState(state, file = statePath()) {   // tmp + rename: a kill mid-save never corrupts the checkpoint
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file + '.tmp', JSON.stringify(state, null, 2));
    renameSync(file + '.tmp', file);
}
export function logEvent(state, type, summary) {
    state.seq++;
    state.event_log.push({ n: state.seq, ts: new Date().toISOString(), type, summary });
    if (state.event_log.length > 50) state.event_log.splice(0, state.event_log.length - 50);
}
// Pick a spot: near a landmark (offset ring) or the next free ring slot around the origin.
export function pickPosition(state, near) {
    const taken = Object.values(state.assets).filter(a => a.x != null);
    const free = (x, z) => taken.every(a => Math.hypot(a.x - x, a.z - z) > 7) && Math.hypot(x, z) > 4;
    const lm = near && state.landmarks[near];
    if (lm) for (let r = 12; r < 40; r += 4) for (let k = 0; k < 8; k++) {
        const x = Math.round(lm.x + r * Math.cos(k * Math.PI / 4)), z = Math.round(lm.z + r * Math.sin(k * Math.PI / 4));
        if (free(x, z)) return { x, z };
    }
    for (let r = 10; r < 200; r += 8) for (let k = 0; k < r / 2; k++) {
        const a = k * 2 * Math.PI / (r / 2), x = Math.round(r * Math.cos(a)), z = Math.round(r * Math.sin(a));
        if (free(x, z)) return { x, z };
    }
    return { x: 0, z: 0 };
}
