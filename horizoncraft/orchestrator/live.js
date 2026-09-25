// Live world signals: Nimble fetches real pages, LFM2 extracts 1-2 facts, the world reacts.
// Big page in -> tiny fact kept: the GC story, on a timer, independent of tickets.
import { env } from '../memory/env.js';
import { fetchPage } from './nimble.js';
import { extractFacts } from '../memory/liquid.js';
import { logEvent } from '../memory/state.js';
import { emit } from '../memory/events.js';

// Each source: a real page + the question LFM2 answers from it + how the answer lands in state.live
const SOURCES = [
    { key: 'weather', url: env.LIVE_WEATHER_URL || 'https://forecast.weather.gov/MapClick.php?lat=37.7749&lon=-122.4194', render: false,
      question: 'What is the current weather condition (one word: clear, cloudy, fog, rain, wind) and temperature in Fahrenheit? Answer as "condition, NN F".' },
    { key: 'headline', url: env.LIVE_NEWS_URL || 'https://news.ycombinator.com/', render: false,
      question: 'What is the top headline on this page? Answer with just the headline text.' },
];

async function playerLocation() {
    try { const l = await (await fetch(`${env.TASKBOARD_URL || 'http://localhost:3100'}/api/location`)).json(); return l.lat != null ? l : null; } catch { return null; }
}

export async function tick(state, { save }) {
    state.live ??= {};
    const loc = await playerLocation();   // weather follows the player; NWS covers the US only, else the SF default page
    if (loc) { SOURCES[0].url = `https://forecast.weather.gov/MapClick.php?lat=${loc.lat.toFixed(4)}&lon=${loc.lon.toFixed(4)}`; state.live.location = { lat: loc.lat, lon: loc.lon }; }
    for (const s of SOURCES) {
        try {
            const page = await fetchPage(s.url, { render: s.render });
            const r = await extractFacts(page.text.slice(0, 8000), s.question);
            const answer = (r.answer || r.facts?.[0] || '').toString().slice(0, 140);
            if (!answer) throw new Error('empty answer');
            state.live[s.key] = { value: answer, source: s.url, ts: new Date().toISOString() };
            if (s.key === 'weather') {
                const v = answer.toLowerCase();
                state.live.real_condition = /rain|shower|drizzle/.test(v) ? 'rain' : /fog|mist|haze/.test(v) ? 'fog' : /cloud|overcast/.test(v) ? 'cloudy' : 'clear';
                const m = v.match(/(-?\d+)\s*°?\s*f/); state.live.temp_f = m ? +m[1] : null;
            }
            state.counters.gc_kept++;
            logEvent(state, 'gc_decision', `keep(live.${s.key}): ${page.text.length} chars -> "${answer}"`);
            emit('browser', 'gc_decision', { op: 'keep', slot: `live.${s.key}`, reason: 'live signal', bytes_in: page.text.length, bytes_kept: answer.length, nimble_ms: page.latencyMs, lfm2_ms: r.latencyMs });
            emit('browser', 'live_update', { key: s.key, value: answer, nimble_ms: page.latencyMs });
        } catch (e) {
            console.warn(`[live] ${s.key} failed: ${e.message.slice(0, 120)}`);
            logEvent(state, 'live_error', `${s.key}: ${e.message.slice(0, 80)}`);
        }
    }
    save();
}

export function start(state, { save, intervalMs = +(env.LIVE_INTERVAL_MS || 300000) } = {}) {
    if (!env.NIMBLE_API_KEY) { console.log('[live] NIMBLE_API_KEY not set; live signals off'); return; }
    tick(state, { save }).catch(() => {});
    setInterval(() => tick(state, { save }).catch(() => {}), intervalMs);
}
