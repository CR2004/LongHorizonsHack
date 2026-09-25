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

const POLL_MS = 5000;
const FAKE = !!env.FAKE_PIPELINE;
const FAKE_DELAY = +(env.FAKE_DELAY_MS || 0);   // slow fake stages so kill/resume can be demoed without keys
const fakeWait = () => new Promise(r => setTimeout(r, FAKE_DELAY));   // FAKE_PIPELINE=1: skip FLUX/Hunyuan, place a sample GLB (for loop/resume testing)

async function parseRequest(state, title) {
    const known = Object.keys(state.landmarks).concat(Object.values(state.assets).filter(a => a.status === 'placed').map(a => a.name));
    const sys = `Turn a world-building request into JSON${title.includes('[photo]') ? ' (the request came with a photo of a person; name = how they call themselves, e.g. "Aman" or "visitor")' : ''}: {"name":"<2-3 word asset name>","prompt":"<FLUX prompt: single object, centered, plain white background, 3/4 view, game asset style>","near":"<one of ${JSON.stringify(known)} or null>","size":<height in meters 2-30>}. Reply with ONLY the JSON.`;
    try { const r = await chatJson(sys, title); return { name: r.json.name || title, prompt: r.json.prompt || title, near: known.includes(r.json.near) ? r.json.near : null, size: Math.min(30, Math.max(2, +r.json.size || 5)) }; }
    catch (e) { return { name: title.slice(0, 30), prompt: `${title}, single object, centered, plain white background, game asset`, near: known.find(k => title.toLowerCase().includes(k)) || null, size: 5 }; }
}

function checkpoint(state, type, payload = {}) {
    const { tokens } = render(state);
    state.context_history.push(tokens); if (state.context_history.length > 200) state.context_history.shift();
    saveState(state);
    emit('system', type, { ...payload, context_chars: tokens * 4 }, tokens);
}

// Weather requests bypass the asset pipeline: "make it rain", "set weather to fog", "reset weather" / "real weather".
const WEATHER_RE = /\b(rain|storm|fog|foggy|mist|cloud|cloudy|overcast|clear|sunny|sun)\b/i;
function weatherRequest(title) {
    const t = title.toLowerCase();
    if (/\b(reset|real|live|actual)\b.*\bweather\b|\bweather\b.*\b(reset|real|live|actual)\b/.test(t)) return { reset: true };
    if (!/\b(weather|make it|let it|set)\b/.test(t) || !WEATHER_RE.test(t)) return null;
    const w = t.match(WEATHER_RE)[1];
    return { condition: /rain|storm/.test(w) ? 'rain' : /fog|mist/.test(w) ? 'fog' : /cloud|overcast/.test(w) ? 'cloudy' : 'clear' };
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

async function processTicket(state, t) {
    const wr = weatherRequest(t.title);
    if (wr) return processWeather(state, t, wr);
    const a = state.assets[t.id] ??= { id: `a${t.id}`, ticket_id: t.id, name: t.title, stage: 'queued', status: 'pending' };
    const goal = `#${t.id} ${t.title}`;
    if (a.stage === 'queued') {
        switchTo(state, 'agent', `parse ${goal}`);
        Object.assign(a, await parseRequest(state, t.photo ? t.title + ' [photo]' : t.title), { stage: 'parsed' });
        await collect(state, `parsed request: ${JSON.stringify(a)}`, { currentGoal: goal, source: 'lfm2' });
        checkpoint(state, 'checkpoint', { ticket: t.id, stage: a.stage, goal_stack: [{ goal }] });
    }
    if (a.stage === 'parsed') {
        switchTo(state, 'flux', t.photo ? 'kontext: selfie -> character' : a.prompt);
        const CHARACTER = 'Turn the person in this photo into a stylized low-poly video game character, full body standing pose, facing the camera, keep their face, hair and clothing recognizable, centered, plain white background, no text';
        const r = FAKE ? await fakeWait().then(() => ({ file: 'build/samples/fake.png', latencyMs: FAKE_DELAY }))
                : t.photo ? await editImage(t.photo, CHARACTER)
                : await generateImage(a.prompt, { width: 768, height: 768 });
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
        Object.assign(a, pickPosition(state, a.near), { rotation: Math.random() * Math.PI * 2, stage: 'placed', status: 'placed' });
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
            for (const bt of open) state.tickets[bt.id] ??= { id: bt.id, title: bt.title, status: 'todo', photo: bt.photo || null };
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
