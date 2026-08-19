#!/usr/bin/env node
/**
 * QA video harness (lane QA-V) — video ground truth for cmuxlayer claims.
 *
 * cmuxlayer is normally the only witness to cmuxlayer: every claim is verified
 * by the same tool suite that produced it. This harness records a live probe
 * from OUTSIDE the system under test — a macOS screen recording of an isolated
 * cmux window — and emits an adjudication manifest that cheap vision sub-agents
 * answer one narrow question at a time.
 *
 * It never merges the two sources itself. The script produces receipts + frames;
 * an Opus lane dispatches Sonnet sub-agents over the manifest and renders the
 * report. See docs/qa-video-harness.md.
 *
 * AIDEV-NOTE: this script only orchestrates. All decision logic that could be
 * wrong in an interesting way lives in scripts/qa-video-lib.mjs and is covered
 * by tests/qa-video-harness.test.ts.
 */

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { DRY_RUN_SPEC, PROBE_SPECS, buildAdjudicationManifest } from "./qa-video-lib.mjs";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

const DEFAULTS = {
  mode: "full",
  cli: "cursor",
  repo: "cmuxlayer",
  captureFps: 15,
  scaleWidth: 0,
  frameFps: 10,
  waitTimeoutMs: 8_000,
  agentReadyTimeoutMs: 180_000,
  root: "",
  serverCommand: "",
  serverArgs: [],
  skipPreflight: false,
  keepWindow: false,
};

function usage() {
  process.stderr.write(`Usage: qa-video-harness.mjs [options]

Requires CMUX_QA_VIDEO=1 (this drives a live cmux and records the screen).

Options:
  --dry-run                 Recorder + frame-extraction self-test only. No agents.
  --cli <claude|codex|cursor|gemini|kiro>  Agent CLI for probe agents (default: ${DEFAULTS.cli})
  --repo <name>             repoGolem repo for spawns (default: ${DEFAULTS.repo})
  --capture-fps <n>         Screen capture framerate (default: ${DEFAULTS.captureFps})
  --scale-width <px>        Downscale the recording to this width (default: native)
  --frame-fps <n>           Frame extraction density around each mark (default: ${DEFAULTS.frameFps})
  --wait-timeout-ms <ms>    Timeout for the wait_for probe (default: ${DEFAULTS.waitTimeoutMs})
  --root <dir>              Output dir (default: results/qa-video/<runId>)
  --server-command <cmd>    MCP server executable
  --server-arg <arg>        Repeatable MCP server arg
  --skip-preflight          Skip the recorder self-test before a full run (NOT recommended)
  --keep-window             Leave the isolated window open for inspection
  --help
`);
}

function parseArgs(argv) {
  const options = { ...DEFAULTS };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--help":
      case "-h":
        usage();
        process.exit(0);
        break;
      case "--dry-run":
        options.mode = "dry-run";
        break;
      case "--cli":
        options.cli = argv[++index];
        break;
      case "--repo":
        options.repo = argv[++index];
        break;
      case "--capture-fps":
        options.captureFps = Number(argv[++index]);
        break;
      case "--scale-width":
        options.scaleWidth = Number(argv[++index]);
        break;
      case "--frame-fps":
        options.frameFps = Number(argv[++index]);
        break;
      case "--wait-timeout-ms":
        options.waitTimeoutMs = Number(argv[++index]);
        break;
      case "--root":
        options.root = resolve(argv[++index]);
        break;
      case "--server-command":
        options.serverCommand = argv[++index];
        break;
      case "--server-arg":
        options.serverArgs.push(argv[++index]);
        break;
      case "--skip-preflight":
        options.skipPreflight = true;
        break;
      case "--keep-window":
        options.keepWindow = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  for (const key of ["captureFps", "frameFps", "waitTimeoutMs"]) {
    if (!Number.isFinite(options[key]) || options[key] <= 0) {
      throw new Error(`--${key} must be a positive number`);
    }
  }
  if (!["claude", "codex", "cursor", "gemini", "kiro"].includes(options.cli)) {
    throw new Error("--cli must be one of: claude, codex, cursor, gemini, kiro");
  }
  return options;
}

function assertOptIn(env = process.env) {
  if (env.CMUX_QA_VIDEO === "1") return;
  throw new Error(
    "Refusing to run the QA video harness: it drives a live cmux and records the screen. Set CMUX_QA_VIDEO=1 to opt in.",
  );
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const nowMs = () => Date.now();

function makeNonce(tag) {
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `QAV-${tag}-${suffix}`;
}

// ---------------------------------------------------------------------------
// cmux CLI
// ---------------------------------------------------------------------------

async function cmux(args, { json = false } = {}) {
  const { stdout } = await execFileAsync("cmux", args, {
    env: { ...process.env, CMUX_QUIET: "1" },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (!json) return stdout.trim();
  return JSON.parse(stdout);
}

async function listWindowIds() {
  const raw = await cmux(["list-windows"]);
  return raw
    .split("\n")
    .map((line) => line.trim().match(/^\*?\s*\d+:\s+([0-9A-Fa-f-]{36})/))
    .filter(Boolean)
    .map((match) => match[1]);
}

/**
 * Read cmux's on-screen windows from CoreGraphics.
 *
 * AIDEV-NOTE: an earlier implementation used System Events / AppleScript and was
 * wrong in three escalating ways. It asked for "the frontmost process", which on
 * a live desktop is whatever the human last touched — the first recording cropped
 * to a browser window and captured private content. Targeting cmux by window
 * title then failed because a freshly created cmux window is intermittently
 * absent from the accessibility window list. And even with correct bounds, cmux
 * does not always open its new window on the main display, so the recorder was
 * capturing a different screen entirely. CoreGraphics is the window server's own
 * list: no Accessibility grant, it always sees the window, and it hands back the
 * CGWindowID that makes all of the above moot.
 */
async function readWindowState() {
  const { stdout } = await execFileAsync("python3", [join(__dirname, "qa-video-windows.py")], {
    maxBuffer: 8 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout);
  if (parsed.error) throw new Error(`window enumeration failed: ${parsed.error}`);
  return parsed;
}

function rectsIntersect(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function displayContaining(displays, bounds) {
  const centre = { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 };
  return (
    displays.find(
      (display) =>
        centre.x >= display.bounds.x &&
        centre.x < display.bounds.x + display.bounds.w &&
        centre.y >= display.bounds.y &&
        centre.y < display.bounds.y + display.bounds.h,
    ) ?? displays.find((display) => display.main) ?? displays[0] ?? null
  );
}

/**
 * Everything the recorder needs about the probe window: which display it is on,
 * the crop rectangle in that display's capture pixels, and whether any other
 * ordinary window is covering it.
 *
 * AIDEV-NOTE: cmux does NOT always open its new window on the main display.
 * Recording display 0 while the probe window sat on display 1 is what made two
 * whole runs' worth of frames show the wrong screen while looking perfectly
 * plausible.
 */
async function probeWindowGeometry(title, { attempts = 3, gapMs = 400 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const found = await probeWindowGeometryOnce(title);
    if (found) return found;
    if (attempt < attempts - 1) await sleep(gapMs);
  }
  return null;
}

/**
 * AIDEV-NOTE: a cmux window drops out of the on-screen window list whenever its
 * Space is not the active one on its display, which it does intermittently right
 * after being moved. A single miss is a flap, not an absence, hence the retry
 * above — an early version treated the first miss as "the window is gone" and
 * aborted runs that were perfectly fine a moment later.
 */
async function probeWindowGeometryOnce(title) {
  const state = await readWindowState();
  const cmuxWindows = state.windows.filter((window) => window.owner === "cmux");
  // The short sibling window is cmux's tab strip, not the window we mean.
  const probe = cmuxWindows.find((window) => window.name === title && window.bounds.h > 200);
  if (!probe) return null;

  const display = displayContaining(state.displays, probe.bounds);
  if (!display) return null;

  // Anything at the same window layer sitting ahead of the probe in front-to-back
  // order and overlapping it is, literally, covering the evidence.
  const occluders = state.windows
    .slice(0, state.windows.indexOf(probe))
    .filter(
      (window) =>
        window.layer === probe.layer &&
        window.bounds.w > 40 &&
        window.bounds.h > 40 &&
        rectsIntersect(window.bounds, probe.bounds),
    )
    .map((window) => `${window.owner}: ${window.name || "(untitled)"}`);

  const scale = display.scale || 1;
  return {
    id: probe.id,
    bounds: probe.bounds,
    display,
    occluders,
    clear: occluders.length === 0,
    crop: {
      x: Math.round((probe.bounds.x - display.bounds.x) * scale),
      y: Math.round((probe.bounds.y - display.bounds.y) * scale),
      width: Math.round(probe.bounds.w * scale),
      height: Math.round(probe.bounds.h * scale),
    },
  };
}

/** True when the probe window exists and nothing ordinary is covering it. */
async function probeWindowIsFrontmost(title) {
  try {
    const geometry = await probeWindowGeometry(title);
    return Boolean(geometry?.clear);
  } catch {
    return false;
  }
}

/** Raise the probe window so the recorded region shows it and not something else. */
async function focusProbeWindow(windowId, title) {
  try {
    await cmux(["focus-window", "--window", windowId]);
  } catch {
    /* non-fatal */
  }
  try {
    await execFileAsync("osascript", ["-e", 'tell application "cmux" to activate']);
  } catch {
    /* cmux may be named differently in a fresh install */
  }
  if (!title) return;
  try {
    await execFileAsync("osascript", [
      "-e",
      `tell application "System Events" to tell process "cmux"
         set frontmost to true
         perform action "AXRaise" of (first window whose name is "${title}")
       end tell`,
    ]);
  } catch {
    /* best effort; the recorder does not care */
  }
}

/**
 * AIDEV-NOTE: a cmux window that is not on the active Space is absent from the
 * on-screen window list and cannot be captured at all ("could not create image
 * from window"). Focusing it brings its Space forward, so the wait re-focuses
 * each round rather than passively polling.
 */
/**
 * Restack-only raise: AXRaise plus app activation, and nothing that touches
 * cmux's own state.
 *
 * AIDEV-NOTE: the per-step re-assert deliberately does NOT call
 * `cmux focus-window`. Doing so between probes churned cmux's surface topology
 * badly enough that spawn_agent started failing with "not live or uniquely
 * resolvable in a complete fresh topology" — the harness was perturbing the
 * system it exists to observe. AXRaise returns before the window server has
 * restacked, hence the settle-and-verify loop.
 */
async function raiseProbeWindow(title, { attempts = 4, settleMs = 400 } = {}) {
  if (!title) return false;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await execFileAsync("osascript", [
        "-e",
        `tell application "System Events" to tell process "cmux"
           set frontmost to true
           perform action "AXRaise" of (first window whose name is "${title}")
         end tell`,
      ]);
    } catch {
      /* verified below by CoreGraphics, not by the raise's own report */
    }
    await sleep(settleMs);
    if (await probeWindowIsFrontmost(title)) return true;
  }
  return false;
}

/**
 * Move the probe window onto a display that no other ordinary window occupies.
 *
 * AIDEV-NOTE: this is the fix that finally made isolation hold. The harness runs
 * from inside a cmux pane, so the operator's own cmux window is being activated
 * constantly by the very commands driving the probe — fighting it for z-order on
 * a shared rectangle is a fight the harness cannot win, and every run that tried
 * ended up recording the operator's window. Occlusion is per-display, so putting
 * the probe window on its own display makes stacking irrelevant. On a
 * single-display machine this is a no-op and the z-order checks still apply.
 */
async function isolateProbeWindowOnOwnDisplay(title, attempt = 0) {
  const state = await readWindowState();
  if (state.displays.length < 2) return false;
  const probe = state.windows.find(
    (window) => window.owner === "cmux" && window.name === title && window.bounds.h > 200,
  );
  if (!probe) return false;

  const occupancy = new Map(state.displays.map((display) => [display.index, 0]));
  for (const window of state.windows) {
    if (window.layer !== probe.layer) continue;
    if (window === probe) continue;
    if (window.bounds.w < 200 || window.bounds.h < 200) continue;
    const display = displayContaining(state.displays, window.bounds);
    if (display) occupancy.set(display.index, (occupancy.get(display.index) ?? 0) + 1);
  }
  const ranked = state.displays
    .slice()
    .sort((a, b) => (occupancy.get(a.index) ?? 0) - (occupancy.get(b.index) ?? 0));
  // Retries walk down the ranking: the emptiest display is a good guess, not a
  // guarantee, and a full-screen window the heuristic under-counts should not
  // wedge the harness onto a display it can never own.
  const target = ranked[attempt % ranked.length];
  if (!target) return false;
  const current = displayContaining(state.displays, probe.bounds);
  if (current && current.index === target.index && attempt === 0) return true;

  try {
    await execFileAsync("osascript", [
      "-e",
      `tell application "System Events" to tell process "cmux" to tell (first window whose name is "${title}")
         set position to {${target.bounds.x}, ${target.bounds.y + 25}}
         set size to {${target.bounds.w}, ${target.bounds.h - 50}}
       end tell`,
    ]);
  } catch {
    return false;
  }
  await sleep(800);
  return true;
}

async function waitForProbeGeometry(probeWindow, timeoutMs = 25_000) {
  const deadline = nowMs() + timeoutMs;
  for (let attempt = 0; ; attempt += 1) {
    await isolateProbeWindowOnOwnDisplay(probeWindow.title, attempt);
    await focusProbeWindow(probeWindow.windowId, probeWindow.title);
    await sleep(800);
    await raiseProbeWindow(probeWindow.title);
    const geometry = await probeWindowGeometry(probeWindow.title).catch(() => null);
    if (geometry?.clear) return geometry;
    if (nowMs() >= deadline) return geometry ?? null;
  }
}

// ---------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------

/**
 * Map a CoreGraphics display index onto its avfoundation input index.
 *
 * ffmpeg names these "Capture screen N" following CGGetActiveDisplayList order,
 * but the surrounding numbering also counts cameras, so the two indices are not
 * interchangeable and must be looked up rather than assumed.
 */
async function screenDeviceIndexFor(displayIndex = 0) {
  const output = await new Promise((resolveOutput) => {
    const child = spawn("ffmpeg", ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""]);
    let buffer = "";
    child.stderr.on("data", (chunk) => {
      buffer += chunk.toString();
    });
    child.on("close", () => resolveOutput(buffer));
  });
  const screens = new Map();
  for (const match of output.matchAll(/\[(\d+)\]\s+Capture screen (\d+)/g)) {
    screens.set(Number(match[2]), match[1]);
  }
  const found = screens.get(Number(displayIndex));
  if (found) return found;
  const fallback = screens.get(0);
  if (fallback) {
    process.stderr.write(
      `[qa-video] warning: no avfoundation input for display ${displayIndex}; falling back to Capture screen 0\n`,
    );
    return fallback;
  }
  throw new Error("ffmpeg reports no screen-capture inputs; check Screen Recording permission");
}

/**
 * ffmpeg/avfoundation screen-region recorder.
 *
 * AIDEV-NOTE: ffmpeg is chosen over `screencapture -v` because it reports its
 * own clock through `-progress`, which is what lets every probe timestamp be
 * mapped onto the recording. `screencapture -v` gives no such signal, so its
 * frames could only ever be aligned by eye.
 *
 * AIDEV-NOTE: capturing the window's own content with `screencapture -l
 * <CGWindowID>` was tried and REJECTED, despite being immune to occlusion,
 * display placement and focus stealing. cmux renders its terminals with Metal,
 * and window-content capture returns the window chrome with a blank content
 * area — the sidebar and title render, the terminal text does not. Do not
 * "improve" this back to window capture without checking a frame first.
 *
 * Because this records a REGION, isolation is not free: the probe window has to
 * be the frontmost thing on that region, which is what the CoreGraphics
 * occlusion check above is for, and what every mark's `frontmost` flag records.
 */
class Recorder {
  constructor({ path, captureFps, scaleWidth, crop, deviceIndex }) {
    this.path = path;
    this.captureFps = captureFps;
    this.scaleWidth = scaleWidth;
    this.crop = crop;
    this.deviceIndex = deviceIndex;
    this.child = null;
    this.t0WallMs = null;
    this.t0VideoS = null;
    this.stderr = "";
  }

  buildFilters() {
    const filters = [];
    if (this.crop) {
      const { x, y, width, height } = this.crop;
      filters.push(`crop=${width}:${height}:${x}:${y}`);
    }
    if (this.scaleWidth > 0) filters.push(`scale=${this.scaleWidth}:-2`);
    filters.push("format=yuv420p");
    return filters.join(",");
  }

  async start() {
    const args = [
      "-hide_banner",
      "-loglevel",
      "warning",
      "-y",
      "-f",
      "avfoundation",
      "-capture_cursor",
      "1",
      "-framerate",
      String(this.captureFps),
      "-i",
      `${this.deviceIndex}:none`,
      "-vf",
      this.buildFilters(),
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "23",
      "-progress",
      "pipe:1",
      this.path,
    ];
    this.child = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString();
    });

    // Wait for the first progress block that carries a real out_time_us. That
    // instant is the anchor between wall clock and recording clock.
    await new Promise((done, fail) => {
      let buffer = "";
      const timer = setTimeout(
        () => fail(new Error(`recorder never reported progress:\n${this.stderr}`)),
        30_000,
      );
      const onExit = () =>
        fail(new Error(`recorder exited before producing frames:\n${this.stderr}`));
      this.child.once("close", onExit);
      this.child.stdout.on("data", (chunk) => {
        buffer += chunk.toString();
        const match = [...buffer.matchAll(/out_time_us=(\d+)/g)].pop();
        if (!match) return;
        const micros = Number(match[1]);
        if (!Number.isFinite(micros) || micros <= 0) return;
        this.t0WallMs = nowMs();
        this.t0VideoS = micros / 1_000_000;
        clearTimeout(timer);
        this.child.off("close", onExit);
        done();
      });
    });
  }

  /** Seconds from the recording's anchor for a wall-clock instant. */
  secondsAt(wallMs) {
    return Math.round((this.t0VideoS + (wallMs - this.t0WallMs) / 1000) * 1000) / 1000;
  }

  async stop() {
    if (!this.child) return;
    const exited = new Promise((done) => this.child.once("close", done));
    this.child.stdin.write("q\n");
    const timer = setTimeout(() => this.child.kill("SIGINT"), 5_000);
    await exited;
    clearTimeout(timer);
    this.child = null;
  }
}

async function probeVideo(path) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=nb_frames,width,height",
    "-show_entries",
    "format=duration,size",
    "-of",
    "json",
    path,
  ]);
  const parsed = JSON.parse(stdout);
  const stream = parsed.streams?.[0] ?? {};
  return {
    frames: Number(stream.nb_frames ?? 0),
    width: Number(stream.width ?? 0),
    height: Number(stream.height ?? 0),
    durationS: Number(parsed.format?.duration ?? 0),
    bytes: Number(parsed.format?.size ?? 0),
  };
}

function assertVideoUsable(info, path) {
  if (info.bytes <= 0) throw new Error(`recording ${path} is empty`);
  if (!(info.durationS > 0)) throw new Error(`recording ${path} has no duration`);
  if (!(info.frames > 0)) throw new Error(`recording ${path} has no decodable frames`);
}

/** Accurate-seek extraction so frame k really is at start + k/fps. */
async function extractFrames({ video, outDir, start, end, fps }) {
  await mkdir(outDir, { recursive: true });
  await execFileAsync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    video,
    "-ss",
    String(start),
    "-to",
    String(end),
    "-vf",
    `fps=${fps}`,
    "-q:v",
    "2",
    join(outDir, "f-%04d.png"),
  ]);
}

// ---------------------------------------------------------------------------
// MCP stdio client
// ---------------------------------------------------------------------------

/**
 * cmux exports the operator pane's identity into every child process. If the
 * harness's MCP server inherits it, cmuxlayer resolves the CALLER as whatever
 * agent is running the harness and starts guarding its surface — the first full
 * run died on `Stable surface UUID ... refusing terminal I/O`. The harness is
 * an outside observer and must carry no caller identity at all.
 *
 * AIDEV-NOTE: CMUX_SOCKET_PATH/CMUX_SOCKET are deliberately kept — those address
 * the cmux daemon, they do not identify a caller.
 */
const CALLER_IDENTITY_ENV = [
  "CMUX_WORKSPACE_ID",
  "CMUX_TAB_ID",
  "CMUX_SURFACE_ID",
  "CMUX_PANEL_ID",
  "CMUX_TERMINAL_LIFECYCLE_ID",
];

function sterileEnv(env = process.env) {
  const copy = { ...env };
  for (const key of CALLER_IDENTITY_ENV) delete copy[key];
  return copy;
}

class McpStdioClient {
  constructor(command, args) {
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.closed = false;
    this.stderr = "";
    this.child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: sterileEnv() });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.onStdout(chunk));
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });
    this.child.on("close", () => {
      this.closed = true;
      for (const [, pending] of this.pending) pending.reject(new Error("MCP server exited"));
      this.pending.clear();
    });
  }

  onStdout(chunk) {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > 0) {
        try {
          this.onMessage(JSON.parse(line));
        } catch {
          /* server logged a non-JSON line; ignore */
        }
      }
      newline = this.buffer.indexOf("\n");
    }
  }

  onMessage(message) {
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      return;
    }
    pending.resolve(message.result ?? {});
  }

  request(method, params, timeoutMs = 180_000) {
    if (this.closed) return Promise.reject(new Error("MCP server already closed"));
    const id = this.nextId++;
    return new Promise((done, fail) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        fail(new Error(`Timed out waiting for ${method} after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          done(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          fail(error);
        },
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async initialize() {
    await this.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "cmuxlayer-qa-video-harness", version: "0.1.0" },
    });
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
  }

  async callTool(name, args, timeoutMs) {
    const result = await this.request("tools/call", { name, arguments: args }, timeoutMs);
    const text = (result.content ?? [])
      .filter((part) => part?.type === "text")
      .map((part) => part.text)
      .join("\n");
    return {
      ok: result.isError !== true,
      text,
      structured: result.structuredContent ?? null,
      raw: result,
    };
  }

  close() {
    try {
      this.child.stdin.end();
      this.child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

function resolveServerCommand(options) {
  if (options.serverCommand) {
    return { command: options.serverCommand, args: options.serverArgs };
  }
  const dist = join(REPO_ROOT, "dist", "index.js");
  if (existsSync(dist)) return { command: process.execPath, args: [dist] };
  const tsx = join(REPO_ROOT, "node_modules", ".bin", "tsx");
  if (existsSync(tsx)) return { command: tsx, args: [join(REPO_ROOT, "src", "index.ts")] };
  throw new Error(
    "No MCP server entrypoint found. Run `bun run build` (creates dist/index.js) or pass --server-command.",
  );
}

// ---------------------------------------------------------------------------
// Run recording helpers
// ---------------------------------------------------------------------------

class RunLog {
  constructor(recorder, probeWindow) {
    this.recorder = recorder;
    this.probeWindow = probeWindow;
    this.steps = [];
  }

  /**
   * Re-assert the raise before every probe. Raising once before the recorder
   * starts is not enough — anything on the desktop can restack at any time, and
   * a five-minute run has already been observed losing the probe window to the
   * operator's own cmux window partway through.
   */
  async enterStep(spec, context = {}) {
    await raiseProbeWindow(this.probeWindow.title);
    return this.step(spec, context);
  }

  step(spec, context = {}) {
    const step = { id: spec.id, title: spec.title, issues: spec.issues, context, marks: {}, calls: [], error: null };
    this.steps.push(step);
    return step;
  }

  /**
   * Marks are wall-clock instants stamped onto the capture timeline.
   *
   * AIDEV-NOTE: every mark records whether the probe window was actually
   * unoccluded at that instant. The recorder captures a screen REGION, so
   * anything stacked over it silently replaces the evidence; a mark with
   * `frontmost: false` is one the manifest refuses to ask a question about.
   */
  async mark(step, name) {
    const wallMs = nowMs();
    const entry = { wallMs, videoS: this.recorder.secondsAt(wallMs), at: new Date(wallMs).toISOString() };
    step.marks[name] = entry;
    entry.frontmost = await probeWindowIsFrontmost(this.probeWindow.title);
    return entry;
  }

  /** Record a tool call verbatim alongside its position on the recording clock. */
  async call(step, client, tool, args, { timeoutMs, mark } = {}) {
    const startedAt = nowMs();
    if (mark) await this.mark(step, mark);
    let receipt = null;
    let error = null;
    try {
      receipt = await client.callTool(tool, args, timeoutMs);
    } catch (thrown) {
      error = thrown instanceof Error ? thrown.message : String(thrown);
    }
    const finishedAt = nowMs();
    step.calls.push({
      tool,
      args,
      receipt,
      error,
      started_at: new Date(startedAt).toISOString(),
      started_video_s: this.recorder.secondsAt(startedAt),
      finished_video_s: this.recorder.secondsAt(finishedAt),
      duration_ms: finishedAt - startedAt,
    });
    return { receipt, error };
  }
}

function structuredOf(result) {
  return result?.receipt?.structured ?? {};
}

function agentIdOf(result) {
  const structured = structuredOf(result);
  return (
    structured.agent_id ??
    structured.agent?.agent_id ??
    structured.spawned?.agent_id ??
    null
  );
}

function surfaceIdOf(result) {
  const structured = structuredOf(result);
  return structured.surface_id ?? structured.surface ?? structured.agent?.surface_id ?? null;
}

async function pollAgentState(client, agentId, predicate, timeoutMs) {
  const startedAt = nowMs();
  let last = null;
  while (nowMs() - startedAt < timeoutMs) {
    const result = await client.callTool("list_agents", { agent_ids: [agentId] });
    const agents = result.structured?.agents ?? [];
    last = agents.find((agent) => (agent.agent_id ?? agent.id) === agentId) ?? null;
    if (last && predicate(last)) return last;
    await sleep(1_500);
  }
  return last;
}

// ---------------------------------------------------------------------------
// Isolated probe window
// ---------------------------------------------------------------------------

async function createProbeWindow(runId) {
  const before = new Set(await listWindowIds());
  const created = await cmux(["new-window"]);
  const match = created.match(/([0-9A-Fa-f-]{36})/);
  if (!match) throw new Error(`could not parse window id from: ${created}`);
  const windowId = match[1];
  if (before.has(windowId)) {
    throw new Error(`new-window returned a pre-existing window (${windowId}); refusing to proceed`);
  }
  await sleep(1_000);
  const listing = await cmux(["workspace", "list", "--window", windowId, "--json"], { json: true });
  const workspace = listing.workspaces?.[0];
  if (!workspace?.ref) throw new Error("probe window has no workspace");
  // The title is the harness's only handle on this window from outside cmux, so
  // it has to be unique and it has to be set on the window itself, not just the
  // workspace (System Events reads the window title).
  // Sanitised because the title is interpolated into an AppleScript string literal.
  const title = `QAV-${String(runId).replace(/[^A-Za-z0-9._-]/g, "-")}`;
  await cmux(["rename-workspace", "--workspace", workspace.ref, "--window", windowId, title]);
  await cmux(["rename-window", "--window", windowId, title]);
  await focusProbeWindow(windowId, title);
  await sleep(800);
  return {
    windowId,
    windowRef: listing.window_ref ?? null,
    workspaceRef: workspace.ref,
    title,
    preExisting: before,
  };
}

async function destroyProbeWindow(probeWindow) {
  if (!probeWindow) return;
  if (probeWindow.preExisting.has(probeWindow.windowId)) {
    process.stderr.write(`Refusing to close pre-existing window ${probeWindow.windowId}\n`);
    return;
  }
  try {
    await cmux(["close-window", "--window", probeWindow.windowId]);
  } catch (error) {
    process.stderr.write(`Teardown warning: ${error instanceof Error ? error.message : error}\n`);
  }
}

async function countSurfaces(workspaceRef, windowId) {
  try {
    const listing = await cmux(
      ["list-pane-surfaces", "--workspace", workspaceRef, "--window", windowId, "--json"],
      { json: true },
    );
    return (listing.surfaces ?? []).length;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

const BUSY_PROMPT =
  "Do exactly this and nothing else: count slowly from 1 to 60, printing one number per line, waiting about two seconds between each line. Do not stop early.";
const FAST_PROMPT = "Reply with the single word ACKNOWLEDGED and then stop. Do nothing else.";

async function runFullProbes({ client, log, options, probeWindow }) {
  const spec = (id) => PROBE_SPECS.find((entry) => entry.id === id);

  // --- Agent A: the busy agent used by probes 1, 4 and 5. ---
  const busySpawn = await log.enterStep({ id: "setup-busy-agent", title: "spawn the busy probe agent", issues: [] });
  const spawnA = await log.call(busySpawn, client, "spawn_agent", {
    repo: options.repo,
    cli: options.cli,
    role: "implementor",
    authority: "worker",
    workspace: probeWindow.workspaceRef,
    prompt: BUSY_PROMPT,
  }, { timeoutMs: options.agentReadyTimeoutMs, mark: "spawn" });
  const agentA = agentIdOf(spawnA);
  const surfaceA = surfaceIdOf(spawnA);
  busySpawn.context = { agentId: agentA, surfaceId: surfaceA };
  if (!agentA) {
    busySpawn.error = spawnA.error ?? "spawn_agent returned no agent_id";
    return;
  }
  const busyState = await pollAgentState(client, agentA, (agent) => agent.state === "working", 90_000);
  // AIDEV-NOTE: recorded because a run has already been observed where the pane
  // was visibly streaming while the registry still said "ready". If this is not
  // "working", the busy-send probe did not test what it claims to test, and the
  // report has to say so rather than quietly reporting on an idle agent.
  busySpawn.context.registryStateWhenBusy = busyState?.state ?? null;

  const paneHintA = `the ${options.cli} agent pane (surface ${surfaceA ?? "?"}, agent ${agentA})`;

  // --- Probe 1: send_to a BUSY agent (#432/#484) ---
  {
    const nonce = makeNonce("BUSY");
    const step = await log.enterStep(spec("busy-send"), {
      nonce,
      paneHint: paneHintA,
      agentId: agentA,
      surfaceId: surfaceA,
      registryStateAtSend: busySpawn.context.registryStateWhenBusy,
    });
    await log.call(step, client, "send_to", { mode: "agent", agent_id: agentA, text: nonce }, { mark: "send", timeoutMs: 60_000 });
    await sleep(2_000);
    await log.mark(step, "plus2");
    await sleep(1_500);
  }

  // --- Probe 5: wait_for on a working agent (#473) ---
  {
    const step = await log.enterStep(spec("wait-for-working"), { paneHint: paneHintA, agentId: agentA });
    const result = await log.call(
      step,
      client,
      "wait_for",
      { agent_id: agentA, target_state: "done", timeout_ms: options.waitTimeoutMs },
      { mark: "call", timeoutMs: options.waitTimeoutMs + 30_000 },
    );
    await log.mark(step, "return");
    const blob = `${result.receipt?.text ?? ""} ${JSON.stringify(result.receipt?.structured ?? {})}`;
    step.context.claimedAlreadyCompleted = /already\s+(completed|done)/i.test(blob);
    step.context.waitDurationMs = step.calls.at(-1)?.duration_ms ?? null;
    await sleep(1_500);
  }

  // --- Probe 4: list_agents x3 over ~20s (#488) ---
  {
    const step = await log.enterStep(spec("list-closure-flap"), { paneHint: paneHintA, agentId: agentA });
    await log.mark(step, "span");
    const closures = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await log.call(step, client, "list_agents", { agent_ids: [agentA], detail: "full" }, { timeoutMs: 60_000 });
      const agents = result.receipt?.structured?.agents ?? [];
      const row = agents.find((agent) => (agent.agent_id ?? agent.id) === agentA) ?? {};
      closures.push({ closure: row.closure ?? null, state: row.state ?? null });
      if (attempt < 2) await sleep(10_000);
    }
    step.context.closures = closures;
    step.context.closureFlapped =
      new Set(closures.map((entry) => JSON.stringify(entry.closure))).size > 1;
    step.context.stateFlapped = new Set(closures.map((entry) => entry.state)).size > 1;
  }

  // --- Agent B: reaches a terminal registry state while its pane stays live. ---
  const fastSpawn = await log.enterStep({ id: "setup-terminal-agent", title: "spawn the short-lived probe agent", issues: [] });
  const spawnB = await log.call(fastSpawn, client, "spawn_agent", {
    repo: options.repo,
    cli: options.cli,
    role: "implementor",
    authority: "worker",
    workspace: probeWindow.workspaceRef,
    prompt: FAST_PROMPT,
  }, { timeoutMs: options.agentReadyTimeoutMs, mark: "spawn" });
  const agentB = agentIdOf(spawnB);
  const surfaceB = surfaceIdOf(spawnB);
  fastSpawn.context = { agentId: agentB, surfaceId: surfaceB };
  const paneHintB = `the short-lived ${options.cli} pane (surface ${surfaceB ?? "?"}, agent ${agentB})`;

  if (agentB) {
    const settled = await pollAgentState(
      client,
      agentB,
      (agent) => ["done", "error", "idle"].includes(agent.state),
      120_000,
    );
    fastSpawn.context.settledState = settled?.state ?? null;

    // --- Probe 2: send_to a stale-terminal registry row (#484) ---
    {
      const nonce = makeNonce("STALE");
      const step = await log.enterStep(spec("stale-terminal-send"), {
        nonce,
        paneHint: paneHintB,
        agentId: agentB,
        registryState: settled?.state ?? null,
      });
      await log.call(step, client, "send_to", { mode: "agent", agent_id: agentB, text: nonce }, { mark: "send", timeoutMs: 60_000 });
      await sleep(2_000);
      await log.mark(step, "plus2");
      await sleep(1_500);
    }

    // --- Probe 3: close_surface(scope:"agent") (#485) ---
    {
      const before = await countSurfaces(probeWindow.workspaceRef, probeWindow.windowId);
      const step = await log.enterStep(spec("close-agent"), {
        paneHint: paneHintB,
        agentId: agentB,
        surfaceCountBefore: before,
      });
      await log.call(step, client, "close_surface", { scope: "agent", agent_id: agentB, force: true }, { mark: "close", timeoutMs: 60_000 });
      await sleep(3_000);
      await log.mark(step, "plus3");
      step.context.surfaceCountAfter = await countSurfaces(probeWindow.workspaceRef, probeWindow.windowId);
      await sleep(1_500);
    }
  } else {
    fastSpawn.error = spawnB.error ?? "spawn_agent returned no agent_id";
  }

  // --- Probe 6: spawn while keystrokes are injected (#434/#440) ---
  {
    const junk = makeNonce("JUNK");
    const step = await log.enterStep(spec("spawn-under-keystrokes"), {
      junk,
      paneHint: "the newly launched agent pane (rightmost in the probe workspace)",
    });
    await log.mark(step, "launch");
    const spawnPromise = log.call(step, client, "spawn_agent", {
      repo: options.repo,
      cli: options.cli,
      role: "implementor",
      authority: "worker",
      workspace: probeWindow.workspaceRef,
      prompt: "Reply with the single word LAUNCHED and then stop.",
    }, { timeoutMs: options.agentReadyTimeoutMs });

    const injectionDeadline = nowMs() + 5_000;
    const injections = [];
    while (nowMs() < injectionDeadline) {
      try {
        await cmux(["send", "--workspace", probeWindow.workspaceRef, "--window", probeWindow.windowId, junk]);
        injections.push({ at: new Date().toISOString(), ok: true });
      } catch (error) {
        injections.push({ at: new Date().toISOString(), ok: false, error: String(error) });
      }
      await sleep(700);
    }
    step.context.injections = injections;
    const spawnC = await spawnPromise;
    step.context.agentId = agentIdOf(spawnC);
    step.context.surfaceId = surfaceIdOf(spawnC);
    await sleep(4_000);
    await log.mark(step, "settle");
    await sleep(2_000);
  }
}

async function runDryRunProbe({ log, probeWindow }) {
  const nonce = makeNonce("CLAPPER");
  const step = await log.enterStep(DRY_RUN_SPEC, { nonce });
  await sleep(1_000);
  await log.mark(step, "clap");
  // A clapperboard: printing a known nonce at a known instant on the recording
  // clock is what proves the wall-clock -> video-clock mapping is real.
  await cmux([
    "send",
    "--workspace",
    probeWindow.workspaceRef,
    "--window",
    probeWindow.windowId,
    `clear; printf '\\n\\n    %s\\n\\n' ${nonce}\n`,
  ]);
  step.calls.push({
    tool: "cmux send (clapper)",
    args: { nonce },
    receipt: { ok: true, structured: { ok: true } },
    error: null,
    started_at: new Date().toISOString(),
  });
  await sleep(4_000);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function runOnce(options, { runId, root }) {
  await mkdir(root, { recursive: true });
  const videoPath = join(root, "video.mov");

  const probeWindow = await createProbeWindow(runId);
  // A killed harness must not leak an isolated window onto the operator's
  // desktop. This is the only teardown path that survives Ctrl-C / SIGTERM.
  const onSignal = () => {
    try {
      execFile("cmux", ["close-window", "--window", probeWindow.windowId], () => process.exit(130));
    } catch {
      process.exit(130);
    }
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  let recorder = null;
  let log = null;
  let geometry = null;
  let occlusionRisk = null;
  const startedAt = new Date().toISOString();
  try {
    geometry = await waitForProbeGeometry(probeWindow);
    if (!geometry) {
      throw new Error(
        `Could not find the probe window "${probeWindow.title}" in the CoreGraphics window list, so there is no window to record.`,
      );
    }
    if (!geometry.clear) {
      throw new Error(
        `The probe window is covered by: ${geometry.occluders.join(", ")}. Recording now would capture those windows instead — ` +
          "ambiguous evidence, and a privacy leak. Move or close them, or free up a second display for the probe window, and re-run.",
      );
    }
    const deviceIndex = await screenDeviceIndexFor(geometry.display.index);
    // Diagnostic: the probe window has been observed vanishing mid-run.
    const stillThere = await probeWindowGeometry(probeWindow.title).catch(() => null);
    process.stderr.write(
      `[qa-video] pre-record check: window="${probeWindow.title}" present=${Boolean(stillThere)} display=${stillThere?.display?.index ?? "?"} clear=${stillThere?.clear}\n`,
    );
    recorder = new Recorder({
      path: videoPath,
      captureFps: options.captureFps,
      scaleWidth: options.scaleWidth,
      crop: geometry.crop,
      deviceIndex,
    });
    await recorder.start();
    log = new RunLog(recorder, probeWindow);

    const beforeProbes = await probeWindowGeometry(probeWindow.title).catch(() => null);
    process.stderr.write(`[qa-video] post-record check: present=${Boolean(beforeProbes)}\n`);
    if (options.mode === "dry-run") {
      await runDryRunProbe({ log, probeWindow });
    } else {
      const server = resolveServerCommand(options);
      const client = new McpStdioClient(server.command, server.args);
      try {
        await client.initialize();
        await runFullProbes({ client, log, options, probeWindow });
      } finally {
        client.close();
      }
    }
    // The window can be restacked mid-run by anything on the desktop. Say so in
    // the receipts rather than letting the frames read as trustworthy.
    occlusionRisk = !(await probeWindowIsFrontmost(probeWindow.title));
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    if (recorder) await recorder.stop();
    if (!options.keepWindow) await destroyProbeWindow(probeWindow);
  }

  const video = await probeVideo(videoPath);
  assertVideoUsable(video, videoPath);

  const run = {
    runId,
    mode: options.mode,
    startedAt,
    finishedAt: new Date().toISOString(),
    options: { ...options, serverArgs: options.serverArgs },
    window: {
      windowId: probeWindow.windowId,
      windowRef: probeWindow.windowRef,
      workspaceRef: probeWindow.workspaceRef,
      title: probeWindow.title,
      cgWindowId: geometry.id,
      bounds: geometry.bounds,
      display: geometry.display,
    },
    video: {
      path: "video.mov",
      fps: options.captureFps,
      frameFps: options.frameFps,
      t0WallMs: recorder.t0WallMs,
      t0VideoS: recorder.t0VideoS,
      occlusionRisk,
      ...video,
    },
    steps: log?.steps ?? [],
  };

  const manifest = buildAdjudicationManifest(run, { fps: options.frameFps });
  let extracted = 0;
  for (const question of manifest.questions) {
    if (!question.frame_window) continue;
    await extractFrames({
      video: videoPath,
      outDir: join(root, question.frame_dir),
      start: question.frame_window.start,
      end: question.frame_window.end,
      fps: question.frame_window.fps,
    });
    const present = [];
    for (const frame of question.frames) {
      try {
        const info = await stat(join(root, frame));
        if (info.size > 0) present.push(frame);
      } catch {
        /* ffmpeg produced fewer frames than the plan predicted */
      }
    }
    question.frames = present;
    question.frame_times = question.frame_times.slice(0, present.length);
    if (present.length === 0) {
      question.unadjudicable_reason = "frame extraction produced no images for this window";
    }
    extracted += present.length;
  }
  manifest.extracted_frames = extracted;

  await writeFile(join(root, "run.json"), `${JSON.stringify(run, null, 2)}\n`, "utf8");
  await writeFile(join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { run, manifest, root, extracted };
}


async function main() {
  assertOptIn();
  const options = parseArgs(process.argv.slice(2));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const baseRunId = `${options.mode}-${stamp}`;
  const baseRoot = options.root || join(REPO_ROOT, "results", "qa-video", baseRunId);

  if (options.mode === "full" && !options.skipPreflight) {
    process.stdout.write("[qa-video] preflight: recorder + frame-extraction self-test\n");
    const preflight = await runOnce(
      { ...options, mode: "dry-run", keepWindow: false },
      { runId: `${baseRunId}-preflight`, root: join(baseRoot, "preflight") },
    );
    if (preflight.extracted === 0) {
      throw new Error(
        "Preflight produced no frames. Refusing to run the full harness against live panes.",
      );
    }
    process.stdout.write(
      `[qa-video] preflight ok: ${preflight.run.video.frames} recorded frames, ${preflight.extracted} extracted.\n` +
        `[qa-video] VISUAL confirmation is still required: adjudicate ${join(preflight.root, "manifest.json")} before trusting the full run.\n`,
    );
  }

  const result = await runOnce(options, { runId: baseRunId, root: baseRoot });
  process.stdout.write(
    [
      `[qa-video] run: ${result.run.runId}`,
      `[qa-video] video: ${join(result.root, "video.mov")} (${result.run.video.durationS}s, ${result.run.video.frames} frames, ${result.run.video.width}x${result.run.video.height}, display ${result.run.window.display?.index})`,
      `[qa-video] receipts: ${join(result.root, "run.json")}`,
      `[qa-video] manifest: ${join(result.root, "manifest.json")} (${result.manifest.questions.length} questions, ${result.extracted} frames)`,
      `[qa-video] next: adjudicate with Sonnet sub-agents, then render the report (docs/qa-video-harness.md)`,
      "",
    ].join("\n"),
  );
}

/** Render a report from a manifest + a verdicts file. Kept here so the whole
 *  lane is one script: `qa-video-harness.mjs report <runDir> <verdicts.json>`. */
async function report(runDir, verdictsPath, outPath) {
  const { buildReportMarkdown } = await import("./qa-video-lib.mjs");
  const run = JSON.parse(await readFile(join(runDir, "run.json"), "utf8"));
  const manifest = JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8"));
  const verdicts = JSON.parse(await readFile(verdictsPath, "utf8"));
  const markdown = buildReportMarkdown(run, manifest, Array.isArray(verdicts) ? verdicts : verdicts.verdicts, {
    now: new Date().toISOString(),
  });
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, markdown, "utf8");
  process.stdout.write(`[qa-video] report written: ${outPath}\n`);
}

const [, , maybeSubcommand] = process.argv;
if (maybeSubcommand === "report") {
  const [runDir, verdictsPath, outPath] = process.argv.slice(3);
  if (!runDir || !verdictsPath || !outPath) {
    process.stderr.write("Usage: qa-video-harness.mjs report <runDir> <verdicts.json> <out.md>\n");
    process.exit(2);
  }
  report(resolve(runDir), resolve(verdictsPath), resolve(outPath)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
} else {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
