export async function closeOwnedSurfaces({ list, close, owned, anchor = new Set() }) {
  const closed = [], retained = [];
  for (const candidate of await list()) {
    const refs = [candidate.id, candidate.ref].filter(Boolean);
    if (!refs.some(ref => owned.has(ref))) continue;
    const current = await list(), row = current.find(row => [row.id, row.ref].some(ref => refs.includes(ref)));
    if (!row) continue;
    if (current.length <= 1 || refs.some(ref => anchor.has(ref))) { retained.push(row); continue; }
    const id = row.id ?? row.ref;
    if (!id) throw new Error("owned surface identity absent");
    await close(id);
    if ((await list()).some(row => [row.id, row.ref].some(ref => refs.includes(ref)))) throw new Error("owned surface close unverified");
    closed.push(id);
  }
  return { closed, retained };
}
