// Hosted image -> 3D via fal.ai queue API. Default: fal-ai/hunyuan3d/v2 (returns GLB). Fallback: v3.1 rapid (OBJ only,
// its textures are not in the response). Output is .glb or .obj; the viewer loads both.
// Docs: https://fal.ai/models/fal-ai/hunyuan3d/v2/api  · queue: POST https://queue.fal.run/{model}, GET .../requests/{id}/status, GET .../requests/{id}
// Also works with other fal image-to-3D models by changing FAL_3D_MODEL (e.g. fal-ai/trellis, fal-ai/triposr) — input field may differ.
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { env } from '../memory/env.js';

const headers = () => ({ Authorization: `Key ${env.FAL_KEY}`, 'Content-Type': 'application/json' });

const TRANSIENT = /downstream_service_unavailable|Downstream service unavailable|timed out|\b(429|500|502|503|504)\b|ECONNRESET|fetch failed/i;

// Retry transient fal errors, then fall back to the second model (FAL_3D_MODEL_FALLBACK, default hunyuan3d/v2).
export async function imageToGlbFal(imageFile, opts = {}) {
    const primary = opts.model || env.FAL_3D_MODEL || 'fal-ai/hunyuan3d/v2';                       // returns a real GLB
    const fallback = env.FAL_3D_MODEL_FALLBACK || 'fal-ai/hunyuan-3d/v3.1/rapid/image-to-3d';   // faster, but OBJ-only
    const plan = [[primary, 1], [primary, 2], [fallback, 1], [fallback, 2]];
    let lastErr;
    for (const [model, attempt] of plan) {
        try { return await imageToGlbOnce(imageFile, { ...opts, model }); }
        catch (e) {
            lastErr = e;
            if (!TRANSIENT.test(e.message)) throw e;   // real error (bad input, no balance): don't burn retries
            console.warn(`[fal3d] ${model} attempt ${attempt} failed (transient): ${e.message.slice(0, 120)}; retrying in 5s`);
            await new Promise(r => setTimeout(r, 5000));
        }
    }
    throw lastErr;
}

async function imageToGlbOnce(imageFile, { model, textured = true, seed, outDir = 'build/out', timeoutMs = 600000 } = {}) {
    if (!env.FAL_KEY) throw new Error('FAL_KEY not set');
    const t0 = Date.now();
    const mime = imageFile.endsWith('.png') ? 'image/png' : 'image/jpeg';
    const input_image_url = `data:${mime};base64,${readFileSync(imageFile).toString('base64')}`;
    const sub = await fetch(`https://queue.fal.run/${model}`, { method: 'POST', headers: headers(), body: JSON.stringify({ input_image_url, ...(model.includes('hunyuan3d/v2') ? { textured_mesh: textured, ...(seed != null && { seed }) } : { enable_pbr: textured }) }) });
    if (!sub.ok) throw new Error(`fal submit ${sub.status}: ${(await sub.text()).slice(0, 300)}`);
    const { request_id, status_url, response_url } = await sub.json();
    const statusUrl = status_url || `https://queue.fal.run/${model}/requests/${request_id}/status`;
    const resultUrl = response_url || `https://queue.fal.run/${model}/requests/${request_id}`;
    let st;
    while (true) {
        if (Date.now() - t0 > timeoutMs) throw new Error(`fal ${request_id} timed out`);
        await new Promise(r => setTimeout(r, 2000));
        st = await (await fetch(statusUrl, { headers: headers() })).json();
        if (st.status === 'COMPLETED') break;
        if (st.status && !['IN_QUEUE', 'IN_PROGRESS'].includes(st.status)) throw new Error(`fal ${request_id}: ${JSON.stringify(st).slice(0, 300)}`);
    }
    const out = await (await fetch(resultUrl, { headers: headers() })).json();
    if (out.detail) throw new Error(`fal ${model}: ${JSON.stringify(out.detail).slice(0, 200)}`);
    mkdirSync(outDir, { recursive: true });
    const stem = path.join(outDir, path.basename(imageFile).replace(/\.\w+$/, ''));
    writeFileSync(stem + '.fal.json', JSON.stringify(out, null, 2));   // keep the raw result for debugging
    // Field names vary by model (model_glb / model_mesh / model_urls.glb) and one of them has returned an OBJ
    // labelled .glb, so try every candidate and keep the first whose bytes are really glTF binary ("glTF" magic).
    const asUrl = v => typeof v === 'string' ? v : v?.url;   // fields are sometimes {url,...} objects, sometimes strings
    const candidates = [out.model_glb, out.model_urls?.glb, out.model_mesh, out.model, ...Object.values(out.model_urls || {})]
        .map(asUrl).filter(u => typeof u === 'string' && /^https?:/.test(u));
    if (!candidates.length) throw new Error(`fal result has no mesh url: ${JSON.stringify(out).slice(0, 300)}`);
    // Download the first candidate that is a mesh: glTF binary ("glTF" magic) -> .glb, Wavefront text -> .obj
    let file = null;
    for (const u of [...new Set(candidates)]) {
        const r = await fetch(u); if (!r.ok) continue;
        const buf = Buffer.from(await r.arrayBuffer());
        const head = buf.subarray(0, 12).toString('latin1');
        if (head.startsWith('glTF')) { file = stem + '.glb'; writeFileSync(file, buf); break; }
        if (/^(#|mtllib|o |v |g )/.test(head)) { file = stem + '.obj'; writeFileSync(file, buf); break; }   // OBJ; viewer handles it untextured
        console.warn(`[fal3d] skipping ${u.split('?')[0].slice(-30)}: not glb/obj (starts "${head.replace(/\n/g, ' ')}")`);
    }
    if (!file) throw new Error(`fal returned no glb/obj mesh among ${candidates.length} candidates`);
    const latencyMs = Date.now() - t0;
    console.log(`[fal3d] ${model} ${imageFile} -> ${file} in ${latencyMs}ms`);
    return { file, latencyMs, seed: out.seed };
}
