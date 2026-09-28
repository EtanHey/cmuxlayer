import { describe, expect, it } from "vitest";
import { collectControlHealth, formatControlHealth } from "../src/control-health.js";

const pid = 25528;
const rows = [
  ...Array.from({ length: 10 }, (_, i) => `f${i}\ntREG\nn/tmp/file-${i}`),
  ...Array.from({ length: 4 }, (_, i) => `f${i + 10}\ntPIPE\nnpipe`),
  ...Array.from({ length: 6 }, (_, i) => `f${i + 14}\ntIPv4\nn*:1234`),
  ...Array.from({ length: 2 }, (_, i) => `f${i + 20}\ntCHR\nn/dev/ptmx`),
].join("\n");
const udp = Array.from({ length: 6 }, (_, i) => `f${i + 14}`).join("\n");

function fake(options: { fail?: boolean; threshold?: string } = {}) {
  let calls = 0;
  let now = Date.parse("2026-09-28T10:00:00Z");
  const execFile = async (file: string, args: string[]) => {
    if (file === "ps" && args.join(" ") === "ax -o pid= -o command=") {
      return { stdout: `${pid} /Applications/cmux.app/Contents/MacOS/cmux` };
    }
    if (file === "lsof") {
      calls++;
      if (options.fail) throw new Error("lsof timed out");
      return { stdout: args.includes("-i") ? `p${pid}\n${udp}` : `p${pid}\n${rows}` };
    }
    return { stdout: "" };
  };
  const collect = () => collectControlHealth({
    env: { PATH: "", CMUXLAYER_CMUX_FD_WARN: options.threshold },
    homeDir: "/tmp/cmuxlayer-fd-test-home",
    tmpDir: "/tmp/cmuxlayer-fd-test-tmp",
    now: () => new Date(now),
    execFile,
  });
  return { collect, calls: () => calls, advance: (ms: number) => { now += ms; } };
}

describe("cmux app fd pressure", () => {
  it("counts numeric descriptors and types, including UDP and ptmx", async () => {
    const health = await fake().collect();
    expect(health.cmux_instances.production.processes[0].fd_pressure).toMatchObject({
      pid, open_fds: 22, udp_fds: 6,
      by_type: { REG: 10, PIPE: 4, KQUEUE: 0, UDP: 6, ptmx: 2, unix: 0, other: 0 },
      warn: false, warn_threshold: 4096,
      sampled_at: "2026-09-28T10:00:00.000Z",
    });
  });

  it("warns at the configured threshold and formats a compact count", async () => {
    const health = await fake({ threshold: "22" }).collect();
    expect(health.cmux_instances.production.processes[0].fd_pressure).toMatchObject({ warn: true, warn_threshold: 22 });
    expect(health.warnings).toContainEqual(expect.stringContaining("cmux_fd_pressure: cmux.app pid 25528 holds 22 fds (udp 6) ≥ 22"));
    expect(formatControlHealth(health)).toContain("cmux_fds: 22 (udp 6)");
  });

  it.each(["invalid", "0", "-1", "1.5"])("ignores invalid threshold %s", async threshold => {
    const health = await fake({ threshold }).collect();
    expect(health.cmux_instances.production.processes[0].fd_pressure).toMatchObject({ warn: false, warn_threshold: 4096 });
    expect(health.warnings).not.toContainEqual(expect.stringContaining("cmux_fd_pressure:"));
  });

  it("returns an error without failing health collection", async () => {
    const health = await fake({ fail: true }).collect();
    expect(health.cmux_instances.production.processes[0].fd_pressure).toEqual({ pid, error: "lsof timed out" });
  });

  it("caches a pid for 60 seconds", async () => {
    const run = fake();
    await run.collect();
    run.advance(59_999);
    await run.collect();
    expect(run.calls()).toBe(2);
    run.advance(1);
    await run.collect();
    expect(run.calls()).toBe(4);
  });
});
