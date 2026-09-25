import { readdirSync } from 'fs';
import { imageToGlb } from '../../build/hunyuan.js';
const img = process.argv[2] || readdirSync('build/out').filter(f => /\.(png|jpe?g)$/.test(f)).map(f => 'build/out/' + f)[0];
if (!img) throw new Error('no image in build/out; run bfl.mjs first');
const r = await imageToGlb(img);
console.log(`RESULT glb=${r.file} latency_ms=${r.latencyMs}`);
