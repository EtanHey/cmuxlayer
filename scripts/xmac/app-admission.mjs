// Adapter stages are required, including the no-op stages for nonfixture modes.
// The native implementation and fake lifecycle tests execute this same order.
export const admissionStages = ["lock", "session", "app", "dmg", "config", "fixture", "environment", "shell", "preferences"];
export async function admitAppStart(adapter, verify = () => {}) {
  for (const name of [...admissionStages, "refreshAndQuit", "launch"]) {
    if (typeof adapter[name] !== "function") throw new Error(`app admission stage missing: ${name}`);
  }
  const stage = async name => {
    await verify(name);
    let value, primary, failed = false;
    try { value = await adapter[name](); } catch (error) { failed = true; primary = error; }
    try { await verify(name); } catch (error) { if (!failed) throw error; }
    if (failed) throw primary;
    return value;
  };
  for (const name of admissionStages) await stage(name);
  // No app effects until all stages pass under the required lock. This callback
  // re-observes the approved PID/start immediately before signalling it.
  await stage("refreshAndQuit");
  return stage("launch");
}
