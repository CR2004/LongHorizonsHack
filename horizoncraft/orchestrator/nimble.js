// Nimble client: one-shot page fetch/extract via https://sdk.nimbleway.com/v2/extract (Bearer auth).
// Docs: https://docs.nimbleway.com/nimble-sdk/web-tools/extract/features/browser-actions
import { env } from '../memory/env.js';
const ENDPOINT = 'https://sdk.nimbleway.com/v2/extract';

export function htmlToText(html = '') {
    return html.replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d|section|article)>/gi, '\n').replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
        .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

// Fetch a page through Nimble; render=true uses the cloud browser (JS pages), false is a plain fetch.
export async function fetchPage(url, { render = false, actions = [] } = {}) {
    if (!env.NIMBLE_API_KEY) throw new Error('NIMBLE_API_KEY not set');
    const t0 = Date.now();
    const body = { url, render, ...(render && actions.length && { browser_actions: actions }) };
    const res = await fetch(ENDPOINT, { method: 'POST', headers: { Authorization: `Bearer ${env.NIMBLE_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { throw new Error(`Nimble ${res.status} non-JSON: ${text.slice(0, 200)}`); }
    if (!res.ok || json.status === 'failed') throw new Error(`Nimble ${res.status}: ${text.slice(0, 300)}`);
    const latencyMs = Date.now() - t0;
    const html = json.data?.html ?? '';
    console.log(`[nimble] ${url} ${res.status} ${html.length} chars in ${latencyMs}ms`);
    return { html, text: htmlToText(html), latencyMs, taskId: json.task_id };
}
