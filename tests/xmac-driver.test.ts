import { expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { connectProcess, targetCommand } from "../scripts/xmac/driver.mjs";

it("SSH uses only m1, quotes shell arguments, and refuses MBP production", () => {
  const opts = { host: "m1", cmux: "prod", dmg: "/pinned", repo: "fixture" };
  expect(targetCommand(opts, "/node", ["a'$(touch /bad)"])).toEqual({ command: "ssh", args: ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "m1", "'/node' 'a'\\''$(touch /bad)'" ] });
  expect(() => targetCommand({ host: "mbp", cmux: "prod" }, "/node")).toThrow("MBP");
});
it("matches target replies by id, propagates failures, and rejects on EOF/exit", async () => {
  const child: any = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough() });
  const wire = connectProcess(child, 100);
  const first = wire.request("call", { name: "list_agents" });
  child.stdout.write('{"id":1,"result":{"agents":[]}}\n');
  expect(await first).toEqual({ agents: [] });
  const bad = wire.request("call");
  child.stdout.write('{"id":2,"error":"target failed"}\n');
  await expect(bad).rejects.toThrow("target failed");
  const interrupted = wire.request("call");
  child.emit("exit", 1);
  await expect(interrupted).rejects.toThrow("target bridge exited");
  await expect(wire.request("call")).rejects.toThrow("closed");
});
it("does not treat target noise or malformed JSON as a receipt", async () => {
  const child: any = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough() });
  const wire = connectProcess(child, 100);
  const pending = wire.request("start");
  child.stdout.write('unexpected output\n');
  await expect(pending).rejects.toThrow();
});
