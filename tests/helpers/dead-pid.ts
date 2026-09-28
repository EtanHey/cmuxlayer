/**
 * A pid with no live process. #926: resume accepts only a confirmed-gone
 * recorded pid as proof that the old session is not running (a null pid is
 * never proof), so happy-path resume fixtures record this one. Probed with
 * signal 0, not spawned: some suites mock `node:child_process`.
 */
export const DEAD_PID = (() => {
  for (let pid = 99_000; pid > 90_000; pid -= 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return pid;
    }
  }
  throw new Error("could not find an unused pid");
})();
