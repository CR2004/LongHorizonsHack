// Rawtree analytics client (the hackathon shared cluster). Docs: https://rawtree.com/docs/quickstart/api
// Auto-created columns are ClickHouse `Dynamic`: cast before JSON/date functions.
//   ingest: POST {RAWTREE_URL}/v1/tables/{table}   body = JSON array of rows
//   query : POST {RAWTREE_URL}/v1/query            body = {"sql": "..."}  (ClickHouse-style SQL)
// Same emit()/flush()/query API the rest of the code used with Tinybird.
import { env } from './env.js';

const TABLE = env.RAWTREE_TABLE || 'events';
const base = () => (env.RAWTREE_URL || 'https://api.rawtree.com').replace(/\/$/, '');
const key = () => env.RAWTREE_API_KEY || env.TINYBIRD_TOKEN;   // TINYBIRD_TOKEN kept as an alias for older .env files
const headers = () => ({ Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json' });

const buffer = [];
let timer = null;

export function makeEvent(world, type, payload = {}, tokens = 0) {
    return {
        ts: new Date().toISOString().replace('T', ' ').replace('Z', ''),
        run_id: env.RUN_ID || 'dev',
        world, type,
        payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
        tokens: Math.max(0, Math.round(tokens)),
    };
}

export async function sendEvents(events) {
    if (!key()) throw new Error('RAWTREE_API_KEY not set');
    const res = await fetch(`${base()}/v1/tables/${TABLE}`, { method: 'POST', headers: headers(), body: JSON.stringify(events) });
    if (!res.ok) throw new Error(`Rawtree ingest ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();   // { inserted: n }
}

// Fire-and-forget, batched every 1s. Never throws into the agent loop.
export function emit(world, type, payload, tokens) {
    if (!key()) return;   // no key: events stay local (dashboard reads state.json)
    buffer.push(makeEvent(world, type, payload, tokens));
    if (!timer) timer = setTimeout(flush, 1000);
}
export async function flush() {
    timer = null;
    const batch = buffer.splice(0);
    if (batch.length) await sendEvents(batch).catch(e => console.warn('[events] send failed:', e.message));
}

export async function query(sql) {
    if (!key()) throw new Error('RAWTREE_API_KEY not set');
    const res = await fetch(`${base()}/v1/query`, { method: 'POST', headers: headers(), body: JSON.stringify({ sql }) });
    if (!res.ok) throw new Error(`Rawtree query ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const j = await res.json();
    return Array.isArray(j) ? j : (j.data ?? j.rows ?? j.result ?? j);
}

// The three "endpoints" the dashboard reads (were Tinybird pipes). run_id optional.
const where = run_id => run_id ? ` AND run_id = '${String(run_id).replace(/'/g, "''")}'` : '';
export const QUERIES = {
    recent_events: ({ run_id, limit = 50 } = {}) => `SELECT ts, run_id, world, type, payload, tokens FROM ${TABLE} WHERE 1${where(run_id)} ORDER BY ts DESC LIMIT ${+limit || 50}`,
    counters: ({ run_id } = {}) => `SELECT countIf(type = 'switch_in') AS switches,
        countIf(type = 'ticket_update' AND JSONExtractString(toString(payload), 'status') = 'done_verified') AS tickets_closed,
        countIf(type = 'resume') AS resumes, countIf(type = 'gc_decision') AS gc_decisions,
        countIf(type = 'gc_decision' AND JSONExtractString(toString(payload), 'op') = 'drop') AS gc_dropped, count() AS total_events
        FROM ${TABLE} WHERE 1${where(run_id)}`,
    context_tokens: ({ run_id, limit = 360 } = {}) => `SELECT toStartOfInterval(CAST(ts AS DateTime64(3)), INTERVAL 10 SECOND) AS t, max(tokens) AS tokens_max FROM ${TABLE} WHERE tokens > 0${where(run_id)} GROUP BY t ORDER BY t DESC LIMIT ${+limit || 360}`,
};
export const queryPipe = (name, params = {}) => query(QUERIES[name](params));
