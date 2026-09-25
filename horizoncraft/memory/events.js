// Tinybird Events API client: POST NDJSON to {TINYBIRD_HOST}/v0/events?name=events
import { env } from './env.js';

const DS = 'events';
const buffer = [];
let timer = null;

export function makeEvent(world, type, payload = {}, tokens = 0) {
    return {
        ts: new Date().toISOString().replace('T', ' ').replace('Z', ''), // DateTime64(3)-friendly
        run_id: env.RUN_ID || 'dev',
        world, type,
        payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
        tokens: Math.max(0, Math.round(tokens)),
    };
}

// Send immediately (awaitable). `wait=true` makes Tinybird ack the write.
export async function sendEvents(events, { wait = false } = {}) {
    if (!env.TINYBIRD_TOKEN) throw new Error('TINYBIRD_TOKEN not set');
    const host = (env.TINYBIRD_HOST || 'https://api.tinybird.co').replace(/\/$/, '');
    const body = events.map(e => JSON.stringify(e)).join('\n');
    const res = await fetch(`${host}/v0/events?name=${DS}${wait ? '&wait=true' : ''}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.TINYBIRD_TOKEN}` },
        body,
    });
    if (!res.ok) throw new Error(`Tinybird ${res.status}: ${await res.text()}`);
    return res.json();
}

// Fire-and-forget, batched every 1s. Never throws into the agent loop.
export function emit(world, type, payload, tokens) {
    if (!env.TINYBIRD_TOKEN) return;   // no token: events stay local (dashboard reads state.json)
    buffer.push(makeEvent(world, type, payload, tokens));
    if (!timer) timer = setTimeout(flush, 1000);
}
export async function flush() {
    timer = null;
    const batch = buffer.splice(0);
    if (batch.length) await sendEvents(batch).catch(e => console.warn('[events] send failed:', e.message));
}

// Read a published pipe endpoint.
export async function queryPipe(name, params = {}) {
    const host = (env.TINYBIRD_HOST || 'https://api.tinybird.co').replace(/\/$/, '');
    const qs = new URLSearchParams({ ...params, token: env.TINYBIRD_TOKEN });
    const res = await fetch(`${host}/v0/pipes/${name}.json?${qs}`);
    if (!res.ok) throw new Error(`Tinybird pipe ${name} ${res.status}: ${await res.text()}`);
    return (await res.json()).data;
}
