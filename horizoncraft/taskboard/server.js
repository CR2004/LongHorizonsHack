// Tiny ticket board. Every control has a stable id / data-testid for Nimble actions.
import express from 'express';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import multer from 'multer';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PORT = process.env.PORT || 3100;
const db = new Database(process.env.DB_PATH || 'taskboard.sqlite');
db.exec(`
CREATE TABLE IF NOT EXISTS tickets (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, body TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open', created_at TEXT DEFAULT CURRENT_TIMESTAMP, closed_at TEXT, photo TEXT);
CREATE TABLE IF NOT EXISTS comments (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL, author TEXT DEFAULT 'agent',
  body TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);`);

const SEED = ['create a stone castle', 'add a dragon near the lake', 'put a lighthouse near the castle', 'a giant mushroom', 'a wooden bridge near the lake'];
function seed() {
    db.exec('DELETE FROM comments; DELETE FROM tickets; DELETE FROM sqlite_sequence;');
    const ins = db.prepare('INSERT INTO tickets (title) VALUES (?)');
    SEED.forEach(t => ins.run(t));
}
try { db.exec('ALTER TABLE tickets ADD COLUMN photo TEXT'); } catch {}
if (db.prepare('SELECT COUNT(*) c FROM tickets').get().c === 0) seed();

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>
:root{--bg:#f6f6f3;--fg:#1b1b1b;--muted:#6b6b6b;--card:#fff;--line:#e3e3de;--accent:#2f6f3e;--closed:#8a8a8a}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#eee;--muted:#9a9a9a;--card:#1f1f1d;--line:#333;--accent:#6fbf7f;--closed:#777}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.45 system-ui,sans-serif}
main{max-width:640px;margin:0 auto;padding:16px}a{color:inherit}h1{font-size:1.4rem;margin:.2em 0 .6em}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:8px 0;display:block;text-decoration:none}
.st{font-size:.8rem;padding:2px 8px;border-radius:99px;border:1px solid currentColor;float:right}
.open{color:var(--accent)}.closed{color:var(--closed)}
input,textarea,button{font:inherit;width:100%;padding:10px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);margin:4px 0}
button{background:var(--accent);color:#fff;border:0;font-weight:600}button.secondary{background:transparent;color:var(--fg);border:1px solid var(--line)}
.muted{color:var(--muted);font-size:.85rem}nav{display:flex;gap:12px;margin-bottom:8px}
</style></head><body><main><nav><a href="/" id="nav-home">Tickets</a><a href="/new" id="nav-new">+ New ticket</a></nav>${body}</main></body></html>`;

const UPLOADS = path.join(ROOT, 'uploads'); mkdirSync(UPLOADS, { recursive: true });
const upload = multer({ dest: UPLOADS, limits: { fileSize: 15 * 1024 * 1024 }, fileFilter: (req, f, cb) => cb(null, /^image\//.test(f.mimetype)) });
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get('/', (req, res) => {
    const rows = db.prepare(`SELECT t.*, (SELECT COUNT(*) FROM comments c WHERE c.ticket_id=t.id) n FROM tickets t
                             ORDER BY (t.status='closed'), t.id`).all();
    res.send(page('Task board', `<h1>Task board</h1><div id="ticket-list">${rows.map(t =>
        `<a class="card" id="ticket-${t.id}" data-testid="ticket-${t.id}" data-status="${t.status}" href="/tickets/${t.id}">
         <span class="st ${t.status}">${t.status}</span><b>#${t.id}</b> ${esc(t.title)}<div class="muted">${t.n} comment(s)</div></a>`).join('')}</div>`));
});

app.get('/new', (req, res) => res.send(page('New ticket', `<h1>New ticket</h1>
<form method="post" action="/tickets" id="new-form" enctype="multipart/form-data"><input id="new-title" data-testid="new-title" name="title" placeholder="e.g. add a dragon near the lake · make it rain · put me in the world" required>
<textarea id="new-body" data-testid="new-body" name="body" rows="3" placeholder="Details (optional)"></textarea>
<label class="muted">Optional: a selfie or photo of yourself. You will appear in the world as a game character.</label><input id="new-photo" data-testid="new-photo" type="file" name="photo" accept="image/*" capture="user">
<button id="new-submit" data-testid="new-submit" type="submit">Create ticket</button></form>`)));

app.post('/tickets', upload.single('photo'), (req, res) => {
    const title = String(req.body.title || '').trim().slice(0, 200);
    if (!title) return res.status(400).send('title required');
    const photo = req.file ? req.file.path : null;
    const { lastInsertRowid } = db.prepare('INSERT INTO tickets (title, body, photo) VALUES (?, ?, ?)').run(title, String(req.body.body || '').slice(0, 2000), photo);
    res.redirect(`/tickets/${lastInsertRowid}`);
});

app.get('/tickets/:id', (req, res) => {
    const t = db.prepare('SELECT * FROM tickets WHERE id=?').get(req.params.id);
    if (!t) return res.status(404).send(page('Not found', '<h1>Ticket not found</h1>'));
    const cs = db.prepare('SELECT * FROM comments WHERE ticket_id=? ORDER BY id').all(t.id);
    res.send(page(`#${t.id} ${t.title}`, `<h1 id="ticket-title">#${t.id} ${esc(t.title)}</h1>
<p><span id="ticket-status" data-testid="ticket-status" data-status="${t.status}" class="st ${t.status}">${t.status}</span></p>
<p>${esc(t.body)}</p>${t.photo ? '<p class="muted" id="has-photo">Photo attached (kept private, used once to make your character)</p>' : ''}<h3>Comments</h3><div id="comments">${cs.map(c =>
        `<div class="card" id="comment-${c.id}"><div class="muted">${esc(c.author)} · ${c.created_at}</div>${esc(c.body)}</div>`).join('') || '<p class="muted">No comments yet.</p>'}</div>
<form method="post" action="/tickets/${t.id}/comments" id="comment-form"><textarea id="comment-input" data-testid="comment-input" name="body" rows="3" placeholder="Add a comment" required></textarea>
<button id="comment-submit" data-testid="comment-submit" type="submit">Comment</button></form>
${t.status === 'open' ? `<form method="post" action="/tickets/${t.id}/close" id="close-form"><button id="close-btn" data-testid="close-btn" class="secondary" type="submit">Close ticket</button></form>`
            : `<form method="post" action="/tickets/${t.id}/reopen" id="reopen-form"><button id="reopen-btn" data-testid="reopen-btn" class="secondary" type="submit">Reopen</button></form>`}`));
});

app.post('/tickets/:id/comments', (req, res) => {
    const body = String(req.body.body || '').trim();
    if (body) db.prepare('INSERT INTO comments (ticket_id, author, body) VALUES (?, ?, ?)').run(req.params.id, String(req.body.author || 'agent'), body.slice(0, 4000));
    res.redirect(`/tickets/${req.params.id}`);
});
app.post('/tickets/:id/close', (req, res) => {
    db.prepare("UPDATE tickets SET status='closed', closed_at=CURRENT_TIMESTAMP WHERE id=?").run(req.params.id);
    res.redirect(`/tickets/${req.params.id}`);
});
app.post('/tickets/:id/reopen', (req, res) => {
    db.prepare("UPDATE tickets SET status='open', closed_at=NULL WHERE id=?").run(req.params.id);
    res.redirect(`/tickets/${req.params.id}`);
});

// JSON API (for checks + dashboard). Reset is guarded by ADMIN_TOKEN.
app.get('/api/tickets', (req, res) => res.json(db.prepare('SELECT * FROM tickets ORDER BY id').all()));
app.get('/api/tickets/:id', (req, res) => {
    const t = db.prepare('SELECT * FROM tickets WHERE id=?').get(req.params.id);
    if (!t) return res.status(404).json({ error: 'not found' });
    res.json({ ...t, comments: db.prepare('SELECT * FROM comments WHERE ticket_id=? ORDER BY id').all(t.id) });
});
app.post('/api/reset', (req, res) => {
    if (!process.env.ADMIN_TOKEN || req.get('x-admin-token') !== process.env.ADMIN_TOKEN) return res.status(403).json({ error: 'forbidden' });
    seed(); res.json({ ok: true });
});
// ---- World viewer + world state (read from the agent's checkpoint file) + generated assets
app.use('/world', express.static(path.join(ROOT, 'world')));
app.use('/dashboard', express.static(path.join(ROOT, 'dashboard')));
app.use('/assets', express.static(path.join(ROOT, 'build/out')));
app.get('/world.json', (req, res) => {
    const f = process.env.STATE_FILE || path.join(ROOT, 'state/horizon.json');
    if (!existsSync(f)) return res.json({ assets: [], pending: 0 });
    const st = JSON.parse(readFileSync(f, 'utf8'));
    const assets = Object.values(st.assets || {}).filter(a => a.status === 'placed');
    const pending = Object.values(st.tickets || {}).filter(t => t.status === 'in_progress').length;
    const live = { ...(st.live || {}) }; live.condition = live.override?.condition || live.real_condition || 'clear';
    res.json({ assets, pending, landmarks: st.landmarks || {}, live });
});
app.get('/state.json', (req, res) => {
    const f = process.env.STATE_FILE || path.join(ROOT, 'state/horizon.json');
    res.set('Access-Control-Allow-Origin', '*');
    res.json(existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {});
});
// Player location (from the viewer's geolocation) -> the agent's weather feed follows the player
let playerLocation = null;
app.post('/api/location', (req, res) => { const { lat, lon } = req.body || {}; if (typeof lat === 'number' && typeof lon === 'number') playerLocation = { lat, lon, ts: Date.now() }; res.json({ ok: !!playerLocation }); });
app.get('/api/location', (req, res) => res.json(playerLocation || {}));
app.get('/healthz', (req, res) => res.send('ok'));

app.listen(PORT, () => console.log(`taskboard on :${PORT}`));
