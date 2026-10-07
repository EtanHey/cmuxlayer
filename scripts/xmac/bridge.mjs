import { createInterface } from "node:readline";
import { startTarget } from "./target-client.mjs";

let driver, finishing, idle;
const finish = () => finishing ??= driver?.close();
const arm = () => { clearTimeout(idle); idle = setTimeout(() => { void finish().finally(() => process.exit(1)); }, 180_000); };
process.stdout.on("error", () => { void finish().finally(() => process.exit(1)); });
try {
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    arm(); let message;
    try {
      message = JSON.parse(line);
      let result;
      if (message.op === "start") {
        if (driver) throw new Error("target already started");
        driver = await startTarget(message.args); result = driver.target;
      } else {
        if (!driver) throw new Error("target not started");
        const { op, args = {} } = message;
        if (op === "finish") result = await finish();
        else if (op === "call") result = await driver.call(args.name, args.args);
        else if (op === "spawnLeadSeat") result = await driver.spawnLeadSeat(args);
        else if (op === "readScreen") result = await driver.readScreen(args.surface);
        else if (op === "processArgs") result = await driver.processArgs(args.agentId);
        else if (op === "verifyClosed") result = await driver.verifyClosed(args.agentId);
        else if (op === "focusedSurface") result = await driver.focusedSurface();
        else if (op === "sweepChildren") result = await driver.sweepChildren();
        else throw new Error("unknown target operation");
      }
      process.stdout.write(JSON.stringify({ id: message.id, result }) + "\n");
    } catch (error) { process.stdout.write(JSON.stringify({ id: message?.id, error: String(error), precondition: error.precondition }) + "\n"); }
  }
} finally { clearTimeout(idle); await finish(); }
