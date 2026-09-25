// Live world signals: Nimble fetches real pages, LFM2 extracts 1-2 facts, the world reacts.
// Big page in -> tiny fact kept: the GC story, on a timer, independent of tickets.
import { env } from '../memory/env.js';
import { fetchPage } from './nimble.js';
import { extractFacts } from '../memory/liquid.js';
import { logEvent } from '../memory/state.js';
import { emit } from '../memory/events.js';

// Each source: a real page + the question LFM2 answers from it + how the answer lands in state.live
const SOURCES = [
    { key: 'weather', fmt: true, url: '', render: false },   // url is set per tick (place / player location / SF)
];
// wttr.in ?format=%C|%t|%T|%S|%s  ->  "Clear|+69°F|00:18:30+0200|05:44:00|17:50:00"  (condition, temp, LOCAL time, sunrise, sunset)
const hm = t => { const m = String(t).match(/(\d{1,2}):(\d{2})/); return m ? +m[1] * 60 + +m[2] : null; };
function parseWttr(text) {
    const [desc = '', temp = '', local = '', rise = '', set = ''] = text.replace(/<[^>]+>/g, '').trim().split('|');
    const temp_f = +(temp.match(/-?\d+/)?.[0]) || null;
    const now = hm(local), r = hm(rise), s = hm(set);
    const is_night = now != null && r != null && s != null ? (now < r || now > s) : null;
    return { desc: desc.trim(), temp_f, local_time: local.slice(0, 5), sunrise: rise.slice(0, 5), sunset: set.slice(0, 5), is_night };
}


async function playerLocation() {
    try { const l = await (await fetch(`${env.TASKBOARD_URL || 'http://localhost:3100'}/api/location`)).json(); return l.lat != null ? l : null; } catch { return null; }
}

export async function tick(state, { save }) {
    state.live ??= {};
    // sky follows: a place from the conversation > the player's location > San Francisco
    const loc = state.live.place ? null : await playerLocation();
    if (loc) state.live.location = { lat: loc.lat, lon: loc.lon };
    const where = state.live.place ? encodeURIComponent(state.live.place) : loc ? `${loc.lat.toFixed(3)},${loc.lon.toFixed(3)}` : 'San%20Francisco';
    SOURCES[0].url = `https://wttr.in/${where}?u&format=${encodeURIComponent('%C|%t|%T|%S|%s')}`;   // ?u = Fahrenheit
    for (const s of SOURCES) {
        try {
            const page = await fetchPage(s.url, { render: s.render });
            let r, answer;
            if (s.fmt) {   // wttr.in format string: condition, temperature, local time, sunrise/sunset -> day/night, no model needed
                const w = parseWttr(page.html); r = { latencyMs: 0 };
                answer = `${w.desc}, ${w.temp_f} F, ${w.local_time} local${w.is_night == null ? '' : w.is_night ? ' (night)' : ' (day)'}`;
                Object.assign(state.live, { local_time: w.local_time, sunrise: w.sunrise, sunset: w.sunset, is_night_real: w.is_night, temp_f: w.temp_f });
                const v = w.desc.toLowerCase();
                state.live.real_condition = /snow|sleet|flurr|blizzard/.test(v) ? 'snow' : /rain|shower|drizzle|thunder/.test(v) ? 'rain' : /fog|mist|haze/.test(v) ? 'fog' : /cloud|overcast/.test(v) ? 'cloudy' : 'clear';
            } else if (s.rss) {   // RSS: headlines are right there in <item><title>, no model needed
                const titles = [...page.html.matchAll(/<item>[\s\S]*?<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/g)].map(m => m[1].replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim()).filter(Boolean).slice(0, 5);
                if (!titles.length) throw new Error('no RSS items');
                state.live.headlines = titles; r = { latencyMs: 0 }; answer = titles[0].slice(0, 140);
            } else {
                r = await extractFacts(page.text.slice(0, 8000), s.question);
                answer = (r.answer || r.facts?.[0] || '').toString().slice(0, 140);
            }
            if (!answer) throw new Error('empty answer');
            state.live[s.key] = { value: answer, source: s.url, ts: new Date().toISOString() };
            if (s.key === 'weather' && !s.fmt) {
                const v = answer.toLowerCase();
                state.live.real_condition = /snow|sleet|flurr/.test(v) ? 'snow' : /rain|shower|drizzle/.test(v) ? 'rain' : /fog|mist|haze/.test(v) ? 'fog' : /cloud|overcast/.test(v) ? 'cloudy' : 'clear';
                const m = v.match(/(-?\d+)\s*°?\s*f/); state.live.temp_f = m ? +m[1] : null;
            }
            state.counters.gc_kept++;
            logEvent(state, 'gc_decision', `keep(live.${s.key}): ${(s.rss ? page.html : page.text).length} chars -> "${answer}"`);
            emit('browser', 'gc_decision', { op: 'keep', slot: `live.${s.key}`, reason: s.rss ? 'rss titles kept, rest dropped' : 'live signal', bytes_in: (s.rss ? page.html : page.text).length, bytes_kept: answer.length, nimble_ms: page.latencyMs, lfm2_ms: r.latencyMs });
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
