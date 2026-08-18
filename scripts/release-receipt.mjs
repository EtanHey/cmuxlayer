#!/usr/bin/env node
//
// Release receipts ledger — the durable record a release leaves behind, so
// "did it actually ship, verify, and land on every Mac?" is answered by a file
// instead of by terminal scrollback (failures-ledger rows 10.5 / 16, #371).
//
//   release-receipt.mjs init <version> [--commit SHA] [--host H]
//   release-receipt.mjs record <version> <dotted.key> <value> [--json]
//   release-receipt.mjs install <version> --result pass|fail --installed STR
//                                          [--mode upgrade|verify-only] [--host H]
//   release-receipt.mjs path <version>
//   release-receipt.mjs show <version>
//
// Ledger dir: $CMUXLAYER_RELEASE_RECEIPTS_DIR, else
// $HOME/.local/state/cmuxlayer/release-receipts. One JSON receipt per version;
// every mutation appends to an in-file event trail and rewrites atomically.
import { hostname } from "node:os";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SCHEMA = "cmuxlayer.release-receipt/v1";

function die(message) {
  process.stderr.write(`release-receipt: ${message}\n`);
  process.exit(2);
}

export function receiptsDir(env = process.env) {
  if (env.CMUXLAYER_RELEASE_RECEIPTS_DIR) {
    return env.CMUXLAYER_RELEASE_RECEIPTS_DIR;
  }
  const home = env.HOME;
  if (!home) die("neither CMUXLAYER_RELEASE_RECEIPTS_DIR nor HOME is set");
  return join(home, ".local", "state", "cmuxlayer", "release-receipts");
}

export function receiptPath(version, env = process.env) {
  return join(receiptsDir(env), `release-${version}.json`);
}

function utcNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function defaultHost(env = process.env) {
  return env.CMUXLAYER_RECEIPT_HOST || hostname().replace(/\..*$/, "");
}

function readReceipt(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function writeReceipt(path, receipt) {
  mkdirSync(join(path, ".."), { recursive: true });
  receipt.updated_at = utcNow();
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(receipt, null, 2)}\n`);
  renameSync(tmp, path);
}

function emptyReceipt(version, env) {
  const now = utcNow();
  return {
    schema: SCHEMA,
    version,
    tag: `v${version}`,
    host: defaultHost(env),
    created_at: now,
    updated_at: now,
    commit: null,
    gates: {},
    artifact: {},
    tap: {},
    verify: {},
    installs: [],
    events: [],
  };
}

/** Loads the receipt for `version`, creating the in-memory shape if absent. */
export function loadOrCreate(version, env = process.env) {
  const path = receiptPath(version, env);
  return { path, receipt: readReceipt(path) ?? emptyReceipt(version, env) };
}

export function setDottedKey(target, dottedKey, value) {
  const parts = dottedKey.split(".");
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    if (typeof cursor[part] !== "object" || cursor[part] === null) {
      cursor[part] = {};
    }
    cursor = cursor[part];
  }
  cursor[parts[parts.length - 1]] = value;
  return target;
}

function flagValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined) die(`${name} needs a value`);
  return value;
}

function positionals(args) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      if (arg !== "--json") i += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

function main(argv) {
  const [command, ...rest] = argv;
  if (!command) die("usage: release-receipt.mjs <init|record|install|path|show> …");

  const args = positionals(rest);
  const version = args[0];
  if (!version) die(`${command} needs a version`);

  if (command === "path") {
    process.stdout.write(`${receiptPath(version)}\n`);
    return;
  }

  if (command === "show") {
    const { path, receipt } = loadOrCreate(version);
    if (!readReceipt(path)) die(`no receipt for ${version} at ${path}`);
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    return;
  }

  const { path, receipt } = loadOrCreate(version);

  if (command === "init") {
    const commit = flagValue(rest, "--commit");
    const host = flagValue(rest, "--host");
    if (commit) receipt.commit = commit;
    if (host) receipt.host = host;
    receipt.events.push({ at: utcNow(), event: "init", key: null });
    writeReceipt(path, receipt);
    process.stdout.write(`${path}\n`);
    return;
  }

  if (command === "record") {
    const key = args[1];
    const raw = args[2];
    if (!key || raw === undefined) {
      die("usage: release-receipt.mjs record <version> <dotted.key> <value> [--json]");
    }
    let value = raw;
    if (rest.includes("--json")) {
      try {
        value = JSON.parse(raw);
      } catch (error) {
        die(`--json value is not valid JSON: ${error.message}`);
      }
    } else if (raw === "true" || raw === "false") {
      value = raw === "true";
    }
    setDottedKey(receipt, key, value);
    receipt.events.push({ at: utcNow(), event: "record", key, value });
    writeReceipt(path, receipt);
    return;
  }

  if (command === "install") {
    const entry = {
      host: flagValue(rest, "--host") ?? defaultHost(),
      result: flagValue(rest, "--result") ?? "unknown",
      installed: flagValue(rest, "--installed") ?? "",
      mode: flagValue(rest, "--mode") ?? "upgrade",
      at: utcNow(),
    };
    receipt.installs.push(entry);
    receipt.events.push({ at: entry.at, event: "install", key: entry.host });
    writeReceipt(path, receipt);
    return;
  }

  die(`unknown command: ${command}`);
}

main(process.argv.slice(2));
