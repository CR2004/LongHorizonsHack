import { generateImage } from '../../build/bfl.js';
const r = await generateImage('Pixel art of a medieval stone castle with red banners, flat colors, simple shapes, front view, plain sky background', { width: 512, height: 512 });
console.log(`RESULT file=${r.file} latency_ms=${r.latencyMs}`);
