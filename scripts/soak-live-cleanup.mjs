export async function closeSpawnedAgent({ call, check, cycle, agentId, surface, surfaceUuid }) {
  const leak = () => {
    check("cleanup", ["cleanup_leak"], { cycle, agent_id: agentId ?? null,
      surface: surface ?? null, surface_uuid: surfaceUuid ?? null,
      stable_identity: surfaceUuid ?? agentId ?? null });
    return { close: null, leaked: true };
  };
  if (!agentId) return leak();

  let close = await call("close_surface", { scope: "agent", agent_id: agentId, force: true }, cycle);
  if (close?.ok !== true || close.agent_stopped !== true || close.surface_closed !== true) {
    close = await call("close_surface", { scope: "agent", agent_id: agentId, force: false }, cycle);
    if (close?.ok !== true || close.agent_stopped !== true || close.surface_closed !== true) {
      return leak();
    }
  }
  return { close, leaked: false };
}
