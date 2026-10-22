import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import ts from "typescript";

// Loaded explicitly by entrypoint tests; production never imports this file.
const ancestry = new URL(import.meta.url).searchParams.get("ancestry");
if (new URL(import.meta.url).searchParams.has("deferStderr")) {
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (...args) => {
    setTimeout(() => write(...args), 100);
    return true;
  };
}
if (!["t3", "allowed", "real"].includes(ancestry)) throw new Error("missing fixture ancestry");
const guardSource = readFileSync(new URL("../../src/t3-code-guard.ts", import.meta.url), "utf8");
const realGuard = `data:text/javascript,${encodeURIComponent(ts.transpileModule(guardSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText)}`;
const source = ancestry === "real"
  ? `export { refuseUnderT3Code } from ${JSON.stringify(realGuard)};`
  : `
import { refuseUnderT3Code as guard } from ${JSON.stringify(realGuard)};
export function refuseUnderT3Code() {
  const lookup = pid => pid === 42
    ? { ppid: 43, command: '/usr/bin/node' }
    : { ppid: 1, command: ${JSON.stringify(ancestry === "t3"
      ? "/Applications/T3 Code (Nightly).app/Contents/MacOS/T3 Code (Nightly)"
      : "/Applications/cmux.app/Contents/MacOS/cmux")} };
  const refused = guard({ parentPid: 42, lookup });
  if (!refused) {
    // Observe allowance at every real entrypoint without starting host services.
    process.stderr.write('cmuxlayer-test: ancestry allowed\\n');
    process.exit(23);
  }
  return refused;
}
`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith("/t3-code-guard.js")) {
      return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
