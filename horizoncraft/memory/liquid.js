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
    if (!m) throw new Error(`LFM2 returned no JSON: ${text.slice(0, 200)}`);
    return JSON.parse(m[0]);
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
keep = durable fact needed later; summarize = useful but verbose, compress to one fact; drop = noise.`;
    const user = `Current goal: ${currentGoal}\nObservation:\n${String(observation).slice(0, 4000)}`;
    const r = await chatJson(system, user);
    if (!['keep', 'summarize', 'drop'].includes(r.json.op)) throw new Error(`bad op: ${r.raw}`);
    return { slot: 'none', content: '', ...r.json, latencyMs: r.latencyMs };
}

// Pull only the facts that answer `question` out of a (wiki) page. TODO(event): tune.
export async function extractFacts(pageText, question) {
    const system = `Extract facts from the page that answer the question. Reply with ONLY JSON:
{"facts":["<short fact>", ...],"answer":"<one sentence>","confident":true|false}`;
    const user = `Question: ${question}\nPage:\n${String(pageText).slice(0, 12000)}`;
    const r = await chatJson(system, user, { maxTokens: 400 });
    return { ...r.json, latencyMs: r.latencyMs };
}
