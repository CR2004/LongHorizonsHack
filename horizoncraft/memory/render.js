// The slice of state that goes into a prompt (kept small; reported as `tokens` so the dashboard can chart it).
export function render(state, { currentGoal } = {}) {
    const inprog = Object.values(state.tickets).filter(t => t.status === 'in_progress').map(t => `#${t.id} ${t.title} [${state.assets[t.id]?.stage ?? 'queued'}]`);
    const placed = Object.values(state.assets).filter(a => a.status === 'placed').map(a => `${a.name}@(${a.x},${a.z})`);
    const lines = [
        currentGoal ? `GOAL: ${currentGoal}` : null,
        inprog.length ? `IN PROGRESS: ${inprog.join('; ')}` : null,
        `LANDMARKS: ${Object.entries(state.landmarks).map(([k, v]) => `${k}(${v.x},${v.z})`).join(', ')}`,
        placed.length ? `PLACED: ${placed.slice(-12).join(', ')}` : null,
        state.knowledge.length ? `KNOWN: ${state.knowledge.slice(-5).map(k => k.fact).join(' | ')}` : null,
        state.personal?.facts?.length ? `ABOUT THE PERSON: ${state.personal.facts.slice(-6).join(' | ')}` : null,
        state.failures.length ? `AVOID: ${state.failures.slice(-3).map(f => `${f.stage}: ${f.reason}`).join(' | ')}` : null,
    ].filter(Boolean);
    const text = lines.join('\n').slice(0, 1200);
    return { text, tokens: Math.ceil(text.length / 4) };
}
