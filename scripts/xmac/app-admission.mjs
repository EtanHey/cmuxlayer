// Adapter stages are required, including the no-op stages for nonfixture modes.
// The native implementation and fake lifecycle tests execute this same order.
export const admissionStages = ["lock", "session", "app", "dmg", "config", "fixture", "environment", "shell", "preferences"];
export async function admitAppStart(adapter, verify = () => {}) {
  for (const name of [...admissionStages, "refreshAndQuit", "launch"]) {
    if (typeof adapter[name] !== "function") throw new Error(`app admission stage missing: ${name}`);
  }
  for (const name of admissionStages) { verify(name); await adapter[name](); verify(name); }
  // No app effects until all stages pass under the required lock. This callback
  // re-observes the approved PID/start immediately before signalling it.
  verify("refreshAndQuit"); await adapter.refreshAndQuit(); verify("refreshAndQuit");
  verify("launch");
  return adapter.launch();
}
