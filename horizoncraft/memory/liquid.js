// Liquid LFM2 client (OpenAI-compatible chat completions).
// Point at Liquid's hosted API, OpenRouter, or a local Ollama purely via .env.
import OpenAI from 'openai';
import { env } from './env.js';

let client;
function getClient() {
    if (!client) {
        if (!env.LIQUID_BASE_URL || !env.LIQUID_MODEL) throw new Error('LIQUID_BASE_URL / LIQUID_MODEL not set in .env');
        client = new OpenAI({ apiKey: env.LIQUID_API_KEY || 'none', baseURL: env.LIQUID_BASE_URL });
    }
    return client;
}

function parseJson(text) {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch { /* fall through: probably truncated by max_tokens */ } }
    // salvage what a small model managed to write before the cut-off
    const answer = text.match(/"answer"\s*:\s*"([^"]{1,200})/)?.[1];
    const fact = text.match(/"facts"\s*:\s*\[\s*"([^"]{1,200})/)?.[1];
    const op = text.match(/"op"\s*:\s*"(keep|summarize|drop)"/)?.[1];
    if (answer || fact || op) return { answer: answer || fact || '', facts: fact ? [fact] : [], confident: false, op, salvaged: true };
    throw new Error(`LFM2 returned no JSON: ${text.slice(0, 200)}`);
}

// Low-level: send system+user, get parsed JSON back, plus latency.
export async function chatJson(system, user, { maxTokens = 300 } = {}) {
    const t0 = Date.now();
    const res = await getClient().chat.completions.create({
        model: env.LIQUID_MODEL,
        temperature: 0,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' }, // constrained JSON (Ollama + most OpenAI-compatible servers)
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    });
    const text = res.choices[0].message.content ?? '';
    return { json: parseJson(text), raw: text, latencyMs: Date.now() - t0, usage: res.usage };
}

const SLOTS = ['tickets', 'goal_stack', 'places', 'inventory', 'knowledge', 'failures', 'none'];

// GC decision for one observation. TODO(event): tune prompt + few-shot examples.
export async function classify(observation, currentGoal) {
    const system = `You are a context garbage collector for a Minecraft+browser agent.
Decide what to do with ONE observation given the current goal.
Reply with ONLY a JSON object: {"op":"keep"|"summarize"|"drop","slot":one of ${JSON.stringify(SLOTS)},"content":"<fact to store, <=120 chars, empty if drop>","reason":"why, in a few words, e.g. inventory count needed for the goal"}
keep = durable fact needed later; summarize = useful but verbose, compress to one fact; drop = noise or already known.
Examples:
- goal "build a lighthouse", observation "Current conditions: Fog, 57 F, wind 10 mph" -> {"op":"keep","slot":"knowledge","content":"weather now: fog, 57F","reason":"world reacts to weather"}
- goal "add a dragon", observation "Picking up item!" -> {"op":"drop","slot":"none","content":"","reason":"transient status"}
- goal "add a dragon", observation "<3000 chars of a wiki page about dragons: winged, 20m wingspan, breathe fire>" -> {"op":"summarize","slot":"knowledge","content":"dragons: winged, ~20m wingspan, breathe fire","reason":"only visual facts matter"}`;
    const user = `Current goal: ${currentGoal}\nObservation:\n${String(observation).slice(0, 4000)}`;
    const r = await chatJson(system, user);
    if (!['keep', 'summarize', 'drop'].includes(r.json.op)) throw new Error(`bad op: ${r.raw}`);
    return { slot: 'none', content: '', ...r.json, latencyMs: r.latencyMs };
}

// Pull only the facts that answer `question` out of a (wiki) page. TODO(event): tune.
export async function extractFacts(pageText, question) {
    const system = `Extract facts from the page that answer the question. Reply with ONLY JSON:
{"answer":"<one sentence, the direct answer>","facts":["<at most 3 short facts>"],"confident":true|false}. Put "answer" first. Keep it short.`;
    const user = `Question: ${question}\nPage:\n${String(pageText).slice(0, 12000)}`;
    const r = await chatJson(system, user, { maxTokens: 300 });
    return { ...r.json, latencyMs: r.latencyMs };
}
