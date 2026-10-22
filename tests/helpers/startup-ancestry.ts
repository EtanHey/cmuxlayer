import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/** Fixture binaries exercise normal startup using the guard's injected lookup. */
export function installAllowedAncestryFixture(distDir: string): void {
  const source = readFileSync(new URL("../../src/t3-code-guard.ts", import.meta.url), "utf8");
  writeFileSync(join(distDir, "t3-code-guard-real.js"), ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText);
  writeFileSync(join(distDir, "t3-code-guard.js"), `
import { refuseUnderT3Code as guard } from './t3-code-guard-real.js';
export function refuseUnderT3Code() {
  return guard({ lookup: () => ({ ppid: 0, command: '/sbin/launchd' }) });
}
`);
}
