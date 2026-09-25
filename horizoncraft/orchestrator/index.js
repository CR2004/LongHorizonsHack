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
    const { tokens } = render(state);   // size of the rendered memory slice (estimate); the chart uses real interpreter prompt tokens
    saveState(state);
    emit('system', type, { ...payload, context_chars: tokens * 4 }, tokens);
}

// Weather requests bypass the asset pipeline: "make it rain", "set weather to fog", "reset weather" / "real weather".
const WEATHER_RE = /\b(rain\w*|storm\w*|fog\w*|mist\w*|cloud\w*|overcast|clear|sunny|sun|snow\w*|night\w*|stars|dark|day\w*|morning|noon)\b/i;
function weatherRequest(title) {
    const t = title.toLowerCase();
    if (/\b(reset|real|live|actual)\b.*\bweather\b|\bweather\b.*\b(reset|real|live|actual)\b/.test(t)) return { reset: true };
    if (!/\b(weather|make it|let it|set)\b/.test(t) || !WEATHER_RE.test(t)) return null;
    const w = t.match(WEATHER_RE)[1];
    if (/night|stars|dark/.test(w)) return { night: true };
    if (/^day|morning|noon/.test(w)) return { night: false };
    return { condition: /snow/.test(w) ? 'snow' : /rain|storm/.test(w) ? 'rain' : /fog|mist/.test(w) ? 'fog' : /cloud|overcast/.test(w) ? 'cloudy' : 'clear' };
}
async function processWeather(state, t, req) {
    state.live ??= {};
    switchTo(state, 'world', req.reset ? 'weather -> live' : `weather override -> ${req.condition}`);
    if (req.reset) delete state.live.override;
    else if (req.night != null) state.live.override = { ...(state.live.override || {}), night: req.night, ticket_id: t.id, ts: new Date().toISOString() };
    else state.live.override = { ...(state.live.override || {}), condition: req.condition, ticket_id: t.id, ts: new Date().toISOString() };
    logEvent(state, 'weather', req.reset ? 'override cleared' : `override ${req.night != null ? (req.night ? 'night' : 'day') : req.condition} (#${t.id})`);
    emit('world', 'weather', { ticket: t.id, ...req });
    checkpoint(state, 'checkpoint', { ticket: t.id, stage: 'weather' });
    await board.commentAndClose(t.id, req.reset ? 'Sky back to live data.' : req.night != null ? `It's ${req.night ? 'night' : 'day'} now (until you say "reset weather").` : `Weather set to ${req.condition} (until you say "reset weather").`);
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
            if (act.condition === 'reset') delete state.live.override;
            else if (act.condition === 'night' || act.condition === 'day') state.live.override = { ...(state.live.override || {}), night: act.condition === 'night', ticket_id: t.id, ts: new Date().toISOString() };
            else state.live.override = { ...(state.live.override || {}), condition: act.condition, ticket_id: t.id, ts: new Date().toISOString() };
            logEvent(state, 'weather', act.condition); emit('world', 'weather', { ticket: t.id, condition: act.condition }); notes.push(`weather: ${act.condition}`); break;
        }
        case 'live_weather': {   // a new place means: show its real weather and time of day there
            state.live.place = act.place || null; delete state.live.override;
            emit('browser', 'live_update', { key: 'place', value: act.place }); notes.push(`sky follows ${act.place}`);
            live.tick(state, { save: () => saveState(state) }).catch(() => {}); break;
        }
        case 'remember': {
            state.personal ??= { facts: [] }; const f = String(act.fact || '').trim().slice(0, 140);
            if (f && !state.personal.facts.includes(f)) { state.personal.facts.push(f); if (state.personal.facts.length > 30) state.personal.facts.shift(); }
            logEvent(state, 'remember', f); emit('agent', 'remember', { fact: f }); notes.push(`remembered: ${f}`); break;
        }
        case 'move': {
            const a = findAsset(state, act.ref); if (!a) { notes.push(`no "${act.ref}" in the world`); break; }
            let pos = null;
            if (act.away_from) {
                const ref = findAsset(state, act.away_from) || (state.landmarks[String(act.away_from).toLowerCase()] ? { ...state.landmarks[String(act.away_from).toLowerCase()], name: act.away_from } : null);
                if (ref) { const dx = a.x - ref.x, dz = a.z - ref.z, d = Math.hypot(dx, dz) || 1; pos = { x: Math.round(ref.x + dx / d * 40), z: Math.round(ref.z + dz / d * 40) }; }
            }
            const anchorOf = ref => { const f = findAsset(state, ref); if (f) return { x: f.x, z: f.z }; const l = state.landmarks[String(ref || '').toLowerCase()]; return l ? { x: l.x, z: l.z } : null; };
            if (!pos && Array.isArray(act.between) && act.between.length === 2) { const p1 = anchorOf(act.between[0]), p2 = anchorOf(act.between[1]); if (p1 && p2) pos = { x: Math.round((p1.x + p2.x) / 2), z: Math.round((p1.z + p2.z) / 2) }; }
            if (!pos && act.near && act.direction) { const p = anchorOf(act.near); const D = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }[String(act.direction).toLowerCase()]; if (p && D) pos = { x: Math.round(p.x + D[0] * 15), z: Math.round(p.z + D[1] * 15) }; }
            if (!pos && act.near) { const k = String(act.near).toLowerCase(); if (state.landmarks[k]) pos = pickPosition(state, k); }
            if (!pos) pos = pickPosition(state, null);
            a.x = pos.x; a.z = pos.z; state.landmarks[a.name.toLowerCase()] = { x: pos.x, z: pos.z, note: `moved by #${t.id}` };
            switchTo(state, 'world', `move ${a.name} -> (${pos.x},${pos.z})`); notes.push(`moved ${a.name}${act.away_from ? ' away from ' + act.away_from : act.near ? ' near ' + act.near : ''}`); break;
        }
        case 'point': {
            const a = findAsset(state, act.ref); state.live.point = a ? a.id : null;
            notes.push(a ? `compass -> ${a.name}` : `no "${act.ref}" to point at`); break;
        }
        case 'remake': case 'remove': {
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
    const promptTokens = r.usage?.prompt_tokens || 0;
    if (promptTokens) { state.context_history.push(promptTokens); if (state.context_history.length > 200) state.context_history.shift(); }
    emit('agent', 'interpret', { ticket: t.id, actions: r.actions.map(a => a.type), latency_ms: r.latencyMs, prompt_tokens: promptTokens, completion_tokens: r.usage?.completion_tokens }, promptTokens);
    if (r.reply) await board.comment(t.id, r.reply).catch(() => {});   // talk first, build after
    const notes = [];
    const builds = r.actions.filter(a => a.type === 'build' && a.what);
    if (t.photo && !builds.length) {   // a photo always means "put this person in the world", whatever else was said
        const nameFact = r.actions.find(a => a.type === 'remember' && /name is|i'?m |this is/i.test(a.fact || ''))?.fact;
        const name = (t.title.match(/(?:i'?m|i am|this is|my name is|call me)\s+([A-Z][\w-]{1,20})/i)?.[1]) || (nameFact?.match(/\b([A-Z][\w-]{1,20})\b/)?.[1]) || (t.author && t.author !== 'visitor' ? t.author : 'visitor');
        builds.push({ type: 'build', what: name, near: null, size: 3 });
    }
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
    const fromPlan = /\(plan\)$/.test(t.author || '');   // filed by the agent itself: already a concrete build, never re-interpret
    if (interpreterOn() && !fromPlan && !t.build && !quickCommand(t.title) && !weatherRequest(t.title)) {
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
        if (!t.build && /\(plan\)$/.test(t.author || '')) { const m = t.title.match(/^(.*?)(?:\s+near\s+(.+))?$/i); t.build = { what: m[1].trim(), near: m[2]?.trim() || null }; }
        const parsed = await parseRequest(state, t.photo ? t.title + ' [photo]' : (t.build ? `${t.build.what}${t.build.near ? ` near ${t.build.near}` : ''}` : t.title));
        if (t.build?.size) parsed.size = Math.min(30, Math.max(2, +t.build.size));
        if (t.build?.what) parsed.name = t.build.what.slice(0, 40);   // the interpreter already named it; don't let LFM2 rename it
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
    const proof = `Placed "${a.name}"${a.near ? ` near the ${a.near}` : ''}.`;
    await board.commentAndClose(t.id, proof);
    t.status = 'done_verified'; state.counters.tickets_closed++;
    logEvent(state, 'ticket_update', `#${t.id} done_verified`);
    emit('board', 'ticket_update', { id: t.id, status: 'done_verified' });
    checkpoint(state, 'checkpoint', { ticket: t.id, stage: 'closed' });
}

async function main() {
    const state = loadState();
    for (const [k, a] of Object.entries(state.assets)) if (a.status !== 'placed' && ['done_verified', 'failed'].includes(state.tickets[k]?.status)) delete state.assets[k];
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
