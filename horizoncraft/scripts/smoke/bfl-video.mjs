import { readdirSync } from 'fs';
import { generateVideo } from '../../build/bfl.js';
const img = process.argv[2] || readdirSync('build/out').filter(f => /\.(png|jpe?g)$/.test(f)).map(f => 'build/out/' + f)[0];
if (!img) throw new Error('no image in build/out; run bfl.mjs first');
const r = await generateVideo(img, 'Slow cinematic camera orbit around the castle, golden hour light, static background', { duration: 5, draft: true });
console.log(`RESULT file=${r.file} latency_ms=${r.latencyMs}`);
