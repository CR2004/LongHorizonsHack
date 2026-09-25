// Hunyuan3D-2 local api_server.py client (teammate's box, default :8081). Image (or text) -> GLB.
// Source of the request shape: Tencent-Hunyuan/Hunyuan3D-2/api_server.py. Single-image only in this server;
// the multi-view model (Hunyuan3D-DiT-v2-mv) needs custom code, so the FLUX turntable idea is NOT wired here.
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { env } from '../memory/env.js';
import { imageToGlbFal } from './fal3d.js';

const base = () => (env.HUNYUAN_URL || 'http://localhost:8081').replace(/\/$/, '');

// Synchronous /generate: returns the GLB bytes. Can take minutes; texture=true needs the 16GB path.
// MESH_PROVIDER=fal (default, hosted) | local (teammate's api_server.py at HUNYUAN_URL)
export async function imageToGlb(imageFile, opts = {}) {
    if ((env.MESH_PROVIDER || 'fal') === 'fal') return imageToGlbFal(imageFile, opts);
    return imageToGlbLocal(imageFile, opts);
}

export async function imageToGlbLocal(imageFile, { texture = false, octree_resolution = 128, num_inference_steps = 5, seed = 1234, face_count = 40000, outDir = 'build/out', timeoutMs = 600000 } = {}) {
    const t0 = Date.now();
    const body = { image: readFileSync(imageFile).toString('base64'), texture, octree_resolution, num_inference_steps, seed, face_count, type: 'glb' };
    const res = await fetch(`${base()}/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`Hunyuan ${res.status}: ${(await res.text()).slice(0, 300)}`);
    mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, path.basename(imageFile).replace(/\.\w+$/, '') + '.glb');
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    const latencyMs = Date.now() - t0;
    console.log(`[hunyuan] ${imageFile} -> ${file} in ${latencyMs}ms`);
    return { file, latencyMs };
}
