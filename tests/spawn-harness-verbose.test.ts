import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Parse the real executable callers without starting a live harness. These
// release/acceptance scripts are outside CI's live runs, so losing diagnostics
// must fail here before any agent or installed runtime is touched.
function spawnArguments(path: string): ts.ObjectLiteralExpression[] {
  const file = ts.createSourceFile(path, readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest, true, path.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const declarations: ts.VariableDeclaration[] = [];
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node)) declarations.push(node);
    if (ts.isCallExpression(node)) {
      const name = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name.text : node.expression.getText(file);
      if (["call", "callTool", "rawCall"].includes(name) && node.arguments.some(
        (arg) => ts.isStringLiteral(arg) && arg.text === "spawn_agent",
      )) calls.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return calls.map((call) => {
    const index = call.arguments.findIndex(
      (arg) => ts.isStringLiteral(arg) && arg.text === "spawn_agent",
    );
    let args: ts.Node | undefined = call.arguments[index + 1];
    if (args && ts.isIdentifier(args)) {
      const name = args.text;
      args = declarations.filter((decl) => ts.isIdentifier(decl.name) &&
        decl.name.text === name && decl.getStart(file) < call.getStart(file)).at(-1)?.initializer;
    }
    expect(args, `${path}: spawn arguments must be inspectable`).toBeDefined();
    expect(args && ts.isObjectLiteralExpression(args), `${path}: spawn argument object`).toBe(true);
    return args as ts.ObjectLiteralExpression;
  });
}

describe("diagnostic-dependent live harness spawn requests", () => {
  it.each([
    ["scripts/soak-live.mjs", 1],
    ["scripts/acceptance-registry-liveness.mjs", 1],
    ["scripts/run-live-agent-harness.mjs", 1],
    ["scripts/bench-daemon.mjs", 2],
    ["scripts/run-live-id-churn-probe.ts", 2],
    ["scripts/run-real-cmux-contract.ts", 1],
  ] as const)("%s requests full receipts for its %i spawn callers", (path, count) => {
    const calls = spawnArguments(path);
    expect(calls).toHaveLength(count);
    for (const args of calls) {
      const verbose = args.properties.filter(ts.isPropertyAssignment).find(
        (property) => property.name.getText().replace(/["']/g, "") === "verbose",
      );
      expect(verbose?.initializer.kind, `${path}: verbose:true preserves diagnostic evidence`)
        .toBe(ts.SyntaxKind.TrueKeyword);
    }
  });
});
