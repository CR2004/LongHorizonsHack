// Re-run a ticket from a given stage (default: 'image' = regenerate the 3D model only).
// Stop the agent first; it holds state in memory and would overwrite this on its next checkpoint.
//   node scripts/redo.mjs <ticket_id> [queued|parsed|image|mesh]
import { loadState, saveState } from '../memory/state.js';
import { existsSync, readFileSync, renameSync } from 'fs';
const [id, stage = 'image'] = process.argv.slice(2);
if (!id) { console.error('usage: node scripts/redo.mjs <ticket_id> [stage]'); process.exit(1); }
const s = loadState();
const t = s.tickets[id], a = s.assets[id];
if (!t || !a) { console.error(`ticket ${id} not in state`); process.exit(1); }
const back = { queued: [], parsed: ['image', 'glb', 'url'], image: ['glb', 'url'], mesh: [] }[stage];
if (!back) { console.error('stage must be queued|parsed|image|mesh'); process.exit(1); }
for (const k of back) delete a[k];
// stage 'mesh': reuse the mesh already on disk; if it was saved as .glb but is really an OBJ, rename so the viewer loads it
if (stage === 'mesh' && a.glb && existsSync(a.glb) && a.glb.endsWith('.glb') && readFileSync(a.glb).subarray(0, 4).toString() !== 'glTF') {
    const obj = a.glb.replace(/\.glb$/, '.obj'); renameSync(a.glb, obj); a.glb = obj; a.url = a.url.replace(/\.glb$/, '.obj');
    console.log(`renamed OBJ-in-disguise to ${obj}`);
}
a.stage = stage; a.status = 'pending'; delete a.x; delete a.z;
delete s.landmarks[(a.name || '').toLowerCase()];
t.status = 'in_progress'; delete t.reason;
saveState(s);
console.log(`ticket #${id} "${t.title}" reset to stage ${stage}; restart the agent and it will resume from there`);
