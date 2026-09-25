// Task board client (plain HTTP; Nimble dropped). Board may run on localhost now.
import { env } from '../memory/env.js';

const base = () => (env.TASKBOARD_URL || 'http://localhost:3100').replace(/\/$/, '');

async function timed(label, p) {
    const t0 = Date.now();
    const r = await p;
    console.log(`[board] ${label} in ${Date.now() - t0}ms`);
    return r;
}

export const board = {
    list: () => timed('list', fetch(`${base()}/api/tickets`).then(r => r.json())),
    get: id => timed(`get ${id}`, fetch(`${base()}/api/tickets/${id}`).then(r => r.json())),
    comment: (id, body, author = 'agent') => timed(`comment ${id}`, fetch(`${base()}/tickets/${id}/comments`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body, author }), redirect: 'manual' })),
    close: id => timed(`close ${id}`, fetch(`${base()}/tickets/${id}/close`, { method: 'POST', redirect: 'manual' })),
    file: (title, author = 'agent') => timed('file', fetch(`${base()}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, author }) }).then(r => r.json())),
    reopen: id => fetch(`${base()}/tickets/${id}/reopen`, { method: 'POST', redirect: 'manual' }),
    // Post proof then close, then re-read to confirm (the "board confirms the close" half of verification).
    async commentAndClose(id, proof) {
        await this.comment(id, proof);
        await this.close(id);
        const t = await this.get(id);
        if (t.status !== 'closed') throw new Error(`ticket ${id} not closed (status=${t.status})`);
        return t;
    },
};
