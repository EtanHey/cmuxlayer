import { expect, it } from "vitest";
import { admitAppStart, admissionStages } from "../scripts/xmac/app-admission.mjs";
import { readStatePaths } from "../scripts/xmac/dedicated-account.mjs";

it.each([...admissionStages, "refreshAndQuit", "launch"])("observes both outcomes of %s while retaining the primary stage error", async target => {
  for (const stageFails of [false, true]) for (const observerFails of [false, true]) {
    const calls: string[] = [], checks: string[] = [], primary = new Error("primary stage"), secondary = new Error("post observer");
    const adapter = Object.fromEntries([...admissionStages, "refreshAndQuit", "launch"].map(name => [name, async () => {
      calls.push(name); if (name === target && stageFails) throw primary; return name;
    }]));
    const result = admitAppStart(adapter, name => {
      checks.push(name); if (name === target && checks.filter(x => x === target).length === 2 && observerFails) throw secondary;
    });
    if (stageFails || observerFails) await expect(result).rejects.toBe(stageFails ? primary : secondary);
    else expect(await result).toBe("launch");
    expect(checks.filter(name => name === target)).toHaveLength(2);
    if (stageFails || observerFails) expect(calls.at(-1)).toBe(target);
  }
});
it("refuses before a failed pre-observer without calling the stage", async () => {
  const calls: string[] = [], adapter = Object.fromEntries([...admissionStages, "refreshAndQuit", "launch"].map(name => [name, async () => calls.push(name)]));
  await expect(admitAppStart(adapter, () => { throw Error("pre observer"); })).rejects.toThrow("pre observer"); expect(calls).toEqual([]);
});
it("preserves even undefined as a thrown primary stage value", async () => {
  const adapter = Object.fromEntries([...admissionStages, "refreshAndQuit", "launch"].map(name => [name, async () => { if (name === "lock") throw undefined; }]));
  let checks = 0;
  await admitAppStart(adapter, () => { if (++checks === 2) throw Error("secondary"); }).then(() => { throw Error("unexpected success"); }, error => expect(error).toBeUndefined());
  expect(checks).toBe(2);
});
function inventory(fault = "", nested = false) {
  const root = "/Users/test/.local/state/cmux", child = root + "/nested";
  const initial: any = { uid: 502, gid: 20, mode: 0o40700, dev: 1, ino: 2, nlink: 2, size: 64, mtimeMs: 1, ctimeMs: 1 };
  let current = { ...initial }, disappeared = false;
  const absent = () => { throw Object.assign(Error("synthetic missing"), { code: "ENOENT" }); };
  const io = {
    lstatSync: (path: string) => {
      if (path !== root && path !== child || disappeared && path === root) return absent();
      const data = path === root ? current : { ...initial, ino: 3 };
      return { ...data, isDirectory: () => fault !== "type" || current.mode === initial.mode,
        isSymbolicLink: () => fault === "symlink" && current.mode !== initial.mode };
    },
    realpathSync: (path: string) => path,
    readdirSync: (path: string) => {
      if (path === (nested ? child : root) && fault) {
        if (fault === "disappeared") disappeared = true;
        else current = { ...current, [fault === "type" || fault === "symlink" ? "mode" : fault]: fault === "mode" ? 0o40777 : 99 };
      }
      return path === root && nested ? ["nested"] : [];
    },
  };
  return { capture: () => readStatePaths([root], io), root, child };
}
it.each([false, true])("retains stable empty/nested directory controls (nested=%s)", nested => {
  const f = inventory("", nested), state = f.capture(); expect(state[f.root]).toMatchObject({ kind: "directory", mode: 0o700 });
  expect(Object.keys(state)).toHaveLength(nested ? 2 : 1);
});
it.each(["mode", "uid", "gid", "dev", "ino", "nlink", "size", "mtimeMs", "ctimeMs", "type", "symlink", "disappeared"])("refuses directory %s drift after recursive traversal", fault => {
  expect(() => inventory(fault, true).capture()).toThrow();
});
