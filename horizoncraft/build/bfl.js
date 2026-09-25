// Black Forest Labs FLUX client. Async API: POST -> {id, polling_url} -> GET polling_url until Ready.
// Docs: https://docs.bfl.ai/quick_start/generating_images  (auth header: x-key; signed result URLs expire in 10 min)
import { writeFileSync, readFileSync, mkdirSync } from 'fs';
import path from 'path';
import { env } from '../memory/env.js';

const BASE = (env.BFL_BASE_URL || 'https://api.bfl.ai/v1').replace(/\/$/, '');
const headers = () => ({ accept: 'application/json', 'Content-Type': 'application/json', 'x-key': env.BFL_API_KEY });

// Shared submit -> poll -> download. Returns {id, file, seed, latencyMs}.
async function submitAndFetch(model, body, { outDir, timeoutMs, extHint }) {
    if (!env.BFL_API_KEY) throw new Error('BFL_API_KEY not set');
    const t0 = Date.now();
    const sub = await fetch(`${BASE}/${model}`, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
    if (!sub.ok) throw new Error(`BFL submit ${sub.status}: ${await sub.text()}`);   // 402 = out of credits, 429 = too many active tasks
    const { id, polling_url } = await sub.json();
    let result;
    while (true) {
        if (Date.now() - t0 > timeoutMs) throw new Error(`BFL ${id} timed out`);
        await new Promise(r => setTimeout(r, 1000));
        const r = await (await fetch(polling_url, { headers: headers() })).json();
        if (r.status === 'Ready') { result = r.result; break; }
        if (['Error', 'Failed', 'Content Moderated', 'Request Moderated'].includes(r.status)) throw new Error(`BFL ${id}: ${r.status} ${JSON.stringify(r).slice(0, 300)}`);
    }
    const dl = await fetch(result.sample);
    if (!dl.ok) throw new Error(`BFL download ${dl.status}`);
    mkdirSync(outDir, { recursive: true });
    const ct = dl.headers.get('content-type') || '';
    const ext = ct.includes('png') ? 'png' : ct.includes('mp4') || extHint === 'mp4' ? 'mp4' : 'jpg';
    const file = path.join(outDir, `${id}.${ext}`);
    writeFileSync(file, Buffer.from(await dl.arrayBuffer()));
    const latencyMs = Date.now() - t0;
    console.log(`[bfl] ${model} ${id} -> ${file} in ${latencyMs}ms`);
    return { id, file, seed: result.seed, latencyMs };
}

// Generate one image and save it locally (the signed URL dies after 10 min). Returns {file, seed, latencyMs}.
export async function generateImage(prompt, { model = env.BFL_MODEL || 'flux-2-pro', width = 1024, height = 1024, seed, outDir = 'build/out', timeoutMs = 120000 } = {}) {
    return submitAndFetch(model, { prompt, width, height, ...(seed != null && { seed }) }, { outDir, timeoutMs });
}

// FLUX Kontext: edit/restyle an input photo. Docs: https://docs.bfl.ai/kontext/kontext_image_editing
// Used for selfies -> game character. Photo stays local; only the base64 goes to BFL for this one call.
export async function editImage(inputFile, prompt, { model = 'flux-kontext-pro', aspect_ratio = '1:1', output_format = 'png', seed, outDir = 'build/out', timeoutMs = 120000 } = {}) {
    const input_image = readFileSync(inputFile).toString('base64');
    return submitAndFetch(model, { prompt, input_image, aspect_ratio, output_format, ...(seed != null && { seed }) }, { outDir, timeoutMs });
}

// FLUX 3 image-to-video: animate a still (the demo "reveal" shot). Docs: https://docs.bfl.ai/flux_3/flux3_video
// keyframes = single image (base64 data URL or https URL). duration 5-20s or 'auto'.
export async function generateVideo(imageFile, prompt, { duration = 5, resolution = 'hd', aspect_ratio = 'auto', generate_audio = false, draft = false, outDir = 'build/out', timeoutMs = 600000 } = {}) {
    const b64 = readFileSync(imageFile).toString('base64');
    const mime = imageFile.endsWith('.png') ? 'image/png' : 'image/jpeg';
    return submitAndFetch('flux-3-video', { mode: 'i2v', prompt, keyframes: `data:${mime};base64,${b64}`, duration, resolution, aspect_ratio, generate_audio, draft }, { outDir, timeoutMs, extHint: 'mp4' });
}
