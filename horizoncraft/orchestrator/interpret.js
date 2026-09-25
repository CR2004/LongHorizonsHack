// Conversation -> {reply, actions}. Uses OpenAI (gpt-5-mini) with the world state and what we know about the person.
// LFM2 stays on GC/extraction; this step needs a model that follows a schema reliably.
import OpenAI from 'openai';
import { env } from '../memory/env.js';
import { render } from '../memory/render.js';

let client;
export const enabled = () => !!env.OPENAI_API_KEY;

const SCHEMA = `Reply with ONLY a JSON object:
{"reply": "<1-2 friendly sentences to the person, present tense, say what you're doing>",
 "actions": [
   {"type":"build","what":"<one physical thing, 1-4 words>","near":"<known landmark name or null>","size":<meters 2-30>},
   {"type":"weather","condition":"clear|cloudy|fog|rain|reset"},
   {"type":"news","query":"<topic or null to reset>"},
   {"type":"live_weather","place":"<city or place whose real weather the sky should follow>"},
   {"type":"remember","fact":"<short durable fact about the person: interest, place, person, plan>"},
   {"type":"move","ref":"<thing>","x":<int>,"z":<int>}, {"type":"remake","ref":"<thing>"}, {"type":"remove","ref":"<thing>"}
 ]}
Rules: build at most 3 things per message; pick things that make the world reflect what the person said (a trip -> landmark of that place; a hobby -> its object; a mood -> weather).
If they mention a real place they are going to or care about, add live_weather for it and a news query about it.
If they just chat with no world change, actions may be [] but still reply. Never invent facts about the person; only remember what they said.`;

export async function interpret(state, message, author) {
    client ??= new OpenAI({ apiKey: env.OPENAI_API_KEY });
    const world = render(state).text;
    const personal = (state.personal?.facts || []).slice(-15).map(f => `- ${f}`).join('\n') || '- (nothing yet)';
    const system = `You are the builder of a small 3D world that mirrors the life and conversation of the person talking to you. You can place objects, change weather, show news on a billboard, and remember things about them.
WORLD NOW:\n${world}\nWHAT YOU KNOW ABOUT ${author || 'the person'}:\n${personal}\n\n${SCHEMA}`;
    const t0 = Date.now();
    const res = await client.chat.completions.create({
        model: env.INTERPRETER_MODEL || 'gpt-5-mini',
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: system }, { role: 'user', content: message }],
    });
    const out = JSON.parse(res.choices[0].message.content || '{}');
    const actions = Array.isArray(out.actions) ? out.actions.filter(a => a && typeof a.type === 'string').slice(0, 8) : [];
    console.log(`[interpret] ${Date.now() - t0}ms -> ${actions.map(a => a.type).join(',') || 'no actions'} | "${(out.reply || '').slice(0, 80)}"`);
    return { reply: String(out.reply || '').slice(0, 300), actions, latencyMs: Date.now() - t0, usage: res.usage };
}
