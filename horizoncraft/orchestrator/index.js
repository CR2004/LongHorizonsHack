// World-builder agent: long-running loop over the request queue (task board).
//   ticket -> parse (LFM2) -> FLUX image -> Hunyuan GLB -> place in world -> comment + close ticket
// Checkpoint after every stage; on restart, resume each in-progress ticket from its saved stage.
import { env } from '../memory/env.js';
import { board } from './board.js';
import { loadState, saveState, logEvent, pickPosition } from '../memory/state.js';
import { collect } from '../memory/gc.js';
import { render } from '../memory/render.js';
import { switchTo } from '../memory/handoff.js';
import { chatJson } from '../memory/liquid.js';
import { emit, flush } from '../memory/events.js';
import { generateImage, editImage } from '../build/bfl.js';
import { imageToGlb } from '../build/hunyuan.js';
import path from 'path';
import * as live from './live.js';
import { interpret, enabled as interpreterOn } from './interpret.js';

const POLL_MS = 5000;
const FAKE = !!env.FAKE_PIPELINE;
const FAKE_DELAY = +(env.FAKE_DELAY_MS || 0);   // slow fake stages so kill/resume can be demoed without keys
const fakeWait = () => new Promise(r => setTimeout(r, FAKE_DELAY));   // FAKE_PIPELINE=1: skip FLUX/Hunyuan, place a sample GLB (for loop/resume testing)

const STYLE = 'single object, centered, plain white background, 3/4 view, stylized low-poly game asset, no text';
// Small models copy templates and miss details, so the parts that must be exact are done in code:
// the FLUX prompt is subject + fixed style, and "near <landmark>" is matched by string, not by the model.
async function parseRequest(state, title) {
    const clean = title.replace(/\[photo\]/g, '').trim();
    const known = Object.keys(state.landmarks).concat(Object.values(state.assets).filter(a => a.status === 'placed').map(a => a.name.toLowerCase()));
    const lc = clean.toLowerCase();
    const nearMatch = known.filter(k => k && lc.includes(k)).sort((a, b) => b.length - a.length)[0] || null;
    const subject = clean.replace(/^(add|create|make|build|put|place|spawn)\s+(me\s+)?(a|an|the)?\s*/i, '').replace(/\s+(near|next to|by|beside|at)\s+.*$/i, '').trim() || clean;
    const base = { name: subject.slice(0, 40), prompt: `${subject}, ${STYLE}`, near: nearMatch, size: 6 };
    const sys = `Given a world-building request, reply with ONLY JSON: {"name":"<2-3 word title-case name of the thing>","size":<realistic height in meters, 2-30>}. Examples: "a wooden bridge near the lake" -> {"name":"Wooden Bridge","size":6}; "add a dragon" -> {"name":"Dragon","size":12}; "a lighthouse" -> {"name":"Lighthouse","size":25}`;
    try {
        const r = await chatJson(sys, clean);
        if (typeof r.json.name === 'string' && r.json.name.trim()) base.name = r.json.name.trim().slice(0, 40);
        if (+r.json.size) base.size = Math.min(30, Math.max(2, +r.json.size));
    } catch (e) { /* keep deterministic defaults */ }
    return base;
}

function checkpoint(state, type, payload = {}) {
    const { tokens } = render(state);
    state.context_history.push(tokens); if (state.context_history.length > 200) state.context_history.shift();
    saveState(state);
    emit('system', type, { ...payload, context_chars: tokens * 4 }, tokens);
}

// Weather requests bypass the asset pipeline: "make it rain", "set weather to fog", "reset weather" / "real weather".
const WEATHER_RE = /\b(rain\w*|storm\w*|fog\w*|mist\w*|cloud\w*|overcast|clear|sunny|sun|snow\w*)\b/i;
function weatherRequest(title) {
    const t = title.toLowerCase();
    if (/\b(reset|real|live|actual)\b.*\bweather\b|\bweather\b.*\b(reset|real|live|actual)\b/.test(t)) return { reset: true };
    if (!/\b(weather|make it|let it|set)\b/.test(t) || !WEATHER_RE.test(t)) return null;
    const w = t.match(WEATHER_RE)[1];
    return { condition: /rain|storm|snow/.test(w) ? 'rain' : /fog|mist/.test(w) ? 'fog' : /cloud|overcast/.test(w) ? 'cloudy' : 'clear' };
}
async function processWeather(state, t, req) {
    state.live ??= {};
    switchTo(state, 'world', req.reset ? 'weather -> live' : `weather override -> ${req.condition}`);
    if (req.reset) delete state.live.override; else state.live.override = { condition: req.condition, ticket_id: t.id, ts: new Date().toISOString() };
    logEvent(state, 'weather', req.reset ? 'override cleared' : `override ${req.condition} (#${t.id})`);
    emit('world', 'weather', { ticket: t.id, ...req });
    checkpoint(state, 'checkpoint', { ticket: t.id, stage: 'weather' });
    await board.commentAndClose(t.id, req.reset ? 'Weather back to live data.' : `Weather set to ${req.condition} (overrides live data until a "reset weather" ticket).`);
    t.status = 'done_verified'; state.counters.tickets_closed++;
    logEvent(state, 'ticket_update', `#${t.id} done_verified`); emit('board', 'ticket_update', { id: t.id, status: 'done_verified' });
    saveState(state);
}

// Quick commands from the chat / in-world keys: no generation, applied to state and closed at once.
function findAsset(state, ref) {
    ref = String(ref || '').trim().toLowerCase();
    return Object.values(state.assets).find(a => a.id === ref) || Object.values(state.assets).filter(a => a.status === 'placed').find(a => (a.name || '').toLowerCase() === ref || ref.includes((a.name || '').toLowerCase()));
}
function quickCommand(title) {
    const t = title.trim(); let m;
    if ((m = t.match(/^news (?:about|on|for) (.+)$/i))) return { kind: 'news', query: m[1].trim().slice(0, 60) };
    if (/^(reset|clear|default) news$/i.test(t)) return { kind: 'news', query: null };
    if ((m = t.match(/^move (.+?) to (-?\d+)\s*,\s*(-?\d+)$/i))) return { kind: 'move', ref: m[1], x: +m[2], z: +m[3] };
    if ((m = t.match(/^(?:remake|redo|regenerate) (.+)$/i))) return { kind: 'remake', ref: m[1] };
    if ((m = t.match(/^(?:remove|delete) (.+)$/i))) return { kind: 'remove', ref: m[1] };
    return null;
}
async function closeQuick(state, t, reply) {
    if (reply) await board.commentAndClose(t.id, reply); else { await board.close(t.id); }
    t.status = 'done_verified'; state.counters.tickets_closed++;
    logEvent(state, 'ticket_update', `#${t.id} done_verified`); emit('board', 'ticket_update', { id: t.id, status: 'done_verified' });
    saveState(state);
}
async function processQuick(state, t, q) {
    state.live ??= {};
    if (q.kind === 'news') {
        state.live.news_query = q.query; switchTo(state, 'browser', q.query ? `news query -> ${q.query}` : 'news query reset');
        emit('browser', 'live_update', { key: 'news_query', value: q.query });
        return closeQuick(state, t, q.query ? `Billboard will show news about "${q.query}" on the next fetch (within ${Math.round(+(env.LIVE_INTERVAL_MS || 300000) / 1000)}s).` : 'Billboard back to the default headline feed.');
    }
    const a = findAsset(state, q.ref);
    if (!a) return closeQuick(state, t, `I don't have anything called "${q.ref}" in the world.`);
    if (q.kind === 'move') {
        a.x = q.x; a.z = q.z; state.landmarks[a.name.toLowerCase()] = { x: q.x, z: q.z, note: `moved by #${t.id}` };
        switchTo(state, 'world', `move ${a.name} -> (${q.x},${q.z})`);
        return closeQuick(state, t, `Moved "${a.name}" to (${q.x}, ${q.z}).`);
    }
    if (q.kind === 'remove') {
        delete state.assets[a.ticket_id]; delete state.landmarks[a.name.toLowerCase()];
        switchTo(state, 'world', `remove ${a.name}`);
        return closeQuick(state, t, `Removed "${a.name}".`);
    }
    if (q.kind === 'remake') {
        // memory -> behaviour: record the rejection, regenerate with a different seed and an explicit "different design" note
        state.failures.push({ ticket_id: a.ticket_id, stage: 'remake', reason: `user rejected "${a.name}" v${(a.version || 1)}`, ts: new Date().toISOString() });
        const prev = state.tickets[a.ticket_id]; delete state.assets[a.ticket_id]; delete state.landmarks[a.name.toLowerCase()];
        state.tickets[t.id] = { ...(state.tickets[t.id] || {}), id: t.id, title: `${prev?.title || a.name}, different design than before`, status: 'in_progress', photo: prev?.photo || null, remakeOf: a.ticket_id, version: (a.version || 1) + 1 };
        switchTo(state, 'agent', `remake ${a.name} (v${(a.version || 1) + 1})`);
        await board.comment(t.id, `Remaking "${a.name}" with a different design (v${(a.version || 1) + 1}). Noted that v${a.version || 1} was rejected.`).catch(() => {});
        saveState(state);
        return processTicket(state, state.tickets[t.id]);
    }
}

// ---- Conversational path: interpret -> reply now -> apply actions (build actions run the normal pipeline)
async function applyAction(state, t, act, notes) {
    state.live ??= {};
    switch (act.type) {
        case 'weather': {
            if (act.condition === 'reset') delete state.live.override; else state.live.override = { condition: act.condition, ticket_id: t.id, ts: new Date().toISOString() };
            logEvent(state, 'weather', act.condition); emit('world', 'weather', { ticket: t.id, condition: act.condition }); notes.push(`weather: ${act.condition}`); break;
        }
        case 'news': { state.live.news_query = act.query || null; emit('browser', 'live_update', { key: 'news_query', value: act.query }); notes.push(act.query ? `billboard: news about ${act.query}` : 'billboard: default news'); break; }
        case 'live_weather': { state.live.place = act.place || null; emit('browser', 'live_update', { key: 'place', value: act.place }); notes.push(`sky follows ${act.place}`); live.tick(state, { save: () => saveState(state) }).catch(() => {}); break; }
        case 'remember': {
            state.personal ??= { facts: [] }; const f = String(act.fact || '').trim().slice(0, 140);
            if (f && !state.personal.facts.includes(f)) { state.personal.facts.push(f); if (state.personal.facts.length > 30) state.personal.facts.shift(); }
            logEvent(state, 'remember', f); emit('agent', 'remember', { fact: f }); notes.push(`remembered: ${f}`); break;
        }
        case 'move': case 'remake': case 'remove': {
            const q = { kind: act.type, ref: act.ref, x: act.x, z: act.z };
            const a = findAsset(state, q.ref); if (!a) { notes.push(`no "${q.ref}" in the world`); break; }
            if (q.kind === 'move') { a.x = q.x; a.z = q.z; state.landmarks[a.name.toLowerCase()] = { x: q.x, z: q.z, note: `moved by #${t.id}` }; notes.push(`moved ${a.name}`); }
            else if (q.kind === 'remove') { delete state.assets[a.ticket_id]; delete state.landmarks[a.name.toLowerCase()]; notes.push(`removed ${a.name}`); }
            else { await board.comment(t.id, `(remake ${a.name})`).catch(() => {}); await processQuick(state, { ...t, title: `remake ${a.name}` }, { kind: 'remake', ref: a.name }); notes.push(`remaking ${a.name}`); }
            break;
        }
    }
}
async function processConversation(state, t) {
    const r = await interpret(state, t.title, t.author);
    emit('agent', 'interpret', { ticket: t.id, actions: r.actions.map(a => a.type), latency_ms: r.latencyMs, tokens: r.usage?.total_tokens });
    if (r.reply) await board.comment(t.id, r.reply).catch(() => {});   // talk first, build after
    const notes = [];
    const builds = r.actions.filter(a => a.type === 'build' && a.what);
    for (const act of r.actions.filter(a => a.type !== 'build')) await applyAction(state, t, act, notes);
    // extra builds become their own requests so each gets the full pipeline + its own checkpoints
    for (const b of builds.slice(1)) await board.file(`${b.what}${b.near ? ` near ${b.near}` : ''}`, `${t.author || 'someone'} (plan)`).catch(() => {});
    saveState(state);
    if (builds.length) {
        const b = builds[0];
        t.build = { what: b.what, near: b.near || null, size: b.size };   // processTicket's pipeline uses this instead of parsing the title
        return null;   // continue into the pipeline
    }
    return notes.length ? `Done: ${notes.join('; ')}.` : '';   // '' = close without another comment (the reply already went out)
}

async function processTicket(state, t) {
    if (interpreterOn() && !t.build && !quickCommand(t.title) && !weatherRequest(t.title)) {
        try {
            const summary = await processConversation(state, t);
            if (summary !== null) return closeQuick(state, t, summary || null);
        } catch (e) { console.warn('[interpret] failed, falling back to command parsing:', e.message.slice(0, 120)); }
    }
    const wr = weatherRequest(t.title);
    if (wr) return processWeather(state, t, wr);
    const q = quickCommand(t.title);
    if (q) return processQuick(state, t, q);
    const a = state.assets[t.id] ??= { id: `a${t.id}`, ticket_id: t.id, name: t.title, stage: 'queued', status: 'pending', author: t.author || null, version: t.version || 1 };
    const goal = `#${t.id} ${t.title}`;
    if (a.stage === 'queued') {
        switchTo(state, 'agent', `parse ${goal}`);
        const parsed = await parseRequest(state, t.photo ? t.title + ' [photo]' : (t.build ? `${t.build.what}${t.build.near ? ` near ${t.build.near}` : ''}` : t.title));
        if (t.build?.size) parsed.size = Math.min(30, Math.max(2, +t.build.size));
        Object.assign(a, parsed, { stage: 'parsed' });
        await collect(state, `parsed request: ${JSON.stringify(a)}`, { currentGoal: goal, source: 'lfm2' });
        checkpoint(state, 'checkpoint', { ticket: t.id, stage: a.stage, goal_stack: [{ goal }] });
    }
    if (a.stage === 'parsed') {
        switchTo(state, 'flux', t.photo ? 'kontext: selfie -> character' : a.prompt);
        const CHARACTER = 'Turn the person in this photo into a stylized low-poly video game character, full body standing pose, facing the camera, keep their face, hair and clothing recognizable, centered, plain white background, no text';
        const r = FAKE ? await fakeWait().then(() => ({ file: 'build/samples/fake.png', latencyMs: FAKE_DELAY }))
                : t.photo ? await editImage(t.photo, CHARACTER)
                : await generateImage(a.prompt, { width: 768, height: 768, seed: t.version > 1 ? Math.floor(Math.random() * 1e6) : undefined });
        if (t.photo) { a.size = Math.min(a.size, 3); a.from_photo = true; }
        a.image = r.file; a.stage = 'image';
        await collect(state, `flux done in ${r.latencyMs}ms, seed ${r.seed}, file ${r.file}`, { currentGoal: goal, source: 'flux' });
        checkpoint(state, 'checkpoint', { ticket: t.id, stage: a.stage, latency_ms: r.latencyMs });
    }
    if (a.stage === 'image') {
        switchTo(state, 'hunyuan', a.image);
        const r = FAKE ? await fakeWait().then(() => ({ file: 'build/samples/fake.glb', latencyMs: FAKE_DELAY })) : await imageToGlb(a.image);
        a.glb = r.file; a.url = `/assets/${path.basename(r.file)}`; a.stage = 'mesh';
        if (FAKE) a.url = '/world/sample.glb';
        await collect(state, `hunyuan done in ${r.latencyMs}ms -> ${r.file}`, { currentGoal: goal, source: 'hunyuan' });
        checkpoint(state, 'checkpoint', { ticket: t.id, stage: a.stage, latency_ms: r.latencyMs });
    }
    if (a.stage === 'mesh') {
        switchTo(state, 'world', `place ${a.name}`);
        Object.assign(a, pickPosition(state, a.near), { rotation: Math.random() * Math.PI * 2, stage: 'placed', status: 'placed', placed_at: new Date().toISOString() });
        state.landmarks[a.name.toLowerCase()] = { x: a.x, z: a.z, note: `from ticket #${t.id}` };
        checkpoint(state, 'checkpoint', { ticket: t.id, stage: a.stage });
    }
    // verify: the world endpoint must actually list it, then the board must confirm the close
    const w = await (await fetch(`${env.TASKBOARD_URL || 'http://localhost:3100'}/world.json`)).json();
    if (!w.assets.some(x => x.id === a.id)) throw new Error('asset not visible in /world.json');
    switchTo(state, 'board', `close #${t.id}`);
    const proof = `Placed "${a.name}" at (${a.x}, ${a.z})${a.near ? ` near ${a.near}` : ''}, height ${a.size}m. Image: ${a.image}. Model: ${a.url}`;
    await board.commentAndClose(t.id, proof);
    t.status = 'done_verified'; state.counters.tickets_closed++;
    logEvent(state, 'ticket_update', `#${t.id} done_verified`);
    emit('board', 'ticket_update', { id: t.id, status: 'done_verified' });
    checkpoint(state, 'checkpoint', { ticket: t.id, stage: 'closed' });
}

async function main() {
    const state = loadState();
    const resuming = Object.values(state.tickets).filter(t => t.status === 'in_progress');
    if (resuming.length) {
        state.counters.resumes++;
        for (const t of resuming) logEvent(state, 'resume', `#${t.id} at stage ${state.assets[t.id]?.stage}`);
        emit('system', 'resume', { tickets: resuming.map(t => ({ id: t.id, stage: state.assets[t.id]?.stage })) });
        console.log('[resume]', resuming.map(t => `#${t.id}@${state.assets[t.id]?.stage}`).join(' '));
    }
    live.start(state, { save: () => saveState(state) });
    console.log('world-builder up. board:', env.TASKBOARD_URL || 'http://localhost:3100', 'fake:', FAKE);
    while (true) {
        try {
            const open = (await board.list()).filter(t => t.status === 'open');
            for (const bt of open) state.tickets[bt.id] ??= { id: bt.id, title: bt.title, status: 'todo', photo: bt.photo || null, author: bt.author || null };
            const next = resuming.shift() || Object.values(state.tickets).find(t => t.status === 'todo' && open.some(o => o.id === t.id));
            if (!next) { await flush(); await new Promise(r => setTimeout(r, POLL_MS)); continue; }
            next.status = 'in_progress'; saveState(state);
            console.log(`[ticket] #${next.id} ${next.title}`);
            try { await processTicket(state, next); }
            catch (e) {
                const stage = state.assets[next.id]?.stage;
                console.error(`[ticket] #${next.id} failed at ${stage}:`, e.message);
                state.failures.push({ ticket_id: next.id, stage, reason: e.message.slice(0, 120), ts: new Date().toISOString() });
                next.status = 'failed'; next.reason = e.message.slice(0, 200);
                emit('system', 'ticket_update', { id: next.id, status: 'failed', stage, reason: next.reason });
                await board.comment(next.id, `FAILED at ${stage}: ${next.reason}`).catch(() => {});
                saveState(state);
            }
            await flush();
        } catch (e) { console.error('[loop]', e.message); await new Promise(r => setTimeout(r, POLL_MS)); }
    }
}
main();
