import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const watchdog = 'launchd/resource-guard/cmux-memory-watchdog.sh';
const forbidden = /\b(?:vmmap|footprint|sample|leaks|heap|lldb|gdb|debugserver|dtrace|task_for_pid|task_read_for_pid|task_inspect_for_pid|mach_vm_read|mach_vm_region|task_info)\b/;
function violations(path: string) {
  return readFileSync(join(root, path), 'utf8').split('\n')
    .flatMap((line, index) => !/^\s*#/.test(line) && forbidden.test(line) ? [`${path}:${index + 1}: ${line.trim()}`] : []);
}
const watchdogPaths = [watchdog, 'launchd/cmux-memory-watchdog/bin/cmux-memory-watchdog.sh'];

function fixture(path: string, body: string, rss = '0', second = rss, status = '0', threshold = '1', pages = '0') {
  // Refuse to source an unsafe revision, even when only running one fixture.
  expect(violations(path)).toEqual([]);
  return spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', `
set -euo pipefail
deny() { printf 'FORBIDDEN_SIDE_EFFECT\\n' >&2; exit 97; }
vmmap() { deny; }; footprint() { deny; }; sample() { deny; }
leaks() { deny; }; heap() { deny; }; task_for_pid() { deny; }
kill() { deny; }; curl() { deny; }; socat() { deny; }; launchctl() { deny; }
ps() {
  case "$*" in
    '-o rss= -p 101') printf '%s\\n' "$TEST_RSS"; return "$TEST_STATUS" ;;
    '-o rss= -p 202') printf '%s\\n' "$TEST_SECOND"; return 0 ;;
    '-axo pid=,command='|'-ww -axo pid=,command=')
      printf '101 /Applications/cmux.app/Contents/MacOS/cmux\\n202 /Applications/cmux NIGHTLY.app/Contents/MacOS/cmux\\n' ;;
    *) deny ;;
  esac
}
pgrep() { printf '101\\n202\\n'; }
vm_stat() { printf 'Mach Virtual Memory Statistics: (page size of 4096 bytes)\\nPages occupied by compressor: %s.\\n' "$TEST_PAGES"; }
source "$1"
# Record decisions only. Never execute a real breach handler or its side effects.
handle_breach() { printf 'decision:%s\\n' "$*"; }
${body}`, 'fixture', join(root, path)], {
    encoding: 'utf8', timeout: 5000,
    env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME,
      CMUX_MEM_WATCHDOG_SOURCE_ONLY: '1', CMUX_MEM_WATCHDOG_THRESHOLD_GB: threshold,
      TEST_RSS: rss, TEST_SECOND: second, TEST_STATUS: status, TEST_PAGES: pages },
  });
}

describe('watchdog no task-port contract', () => {
  it('prohibits task-port probes in both packaged watchdog entrypoints', () => {
    expect(readFileSync(join(root, 'packaging/resource-guard-install.rb'), 'utf8')).toContain('libexec.install "launchd"');
    const dispatcher = readFileSync(join(root, 'src/resource-guard.ts'), 'utf8');
    expect(dispatcher).toContain(watchdog);
    expect(dispatcher).toContain('launchd/cmux-ram-sampler/bin/cmux-ram-sampler.sh');
    expect(watchdogPaths.flatMap(violations)).toEqual([]);
  });

  it('prohibits task-port probing in the enabled watchdog before any threshold comparison', () => {
    // Static-only RED: never source or execute an unfixed watchdog.
    expect(violations(watchdog)).toEqual([]);
  });
});

describe.each(watchdogPaths)('%s safe RSS fixtures', path => {
  it.each([
    ['0', '0'], ['1', '1024'], ['  001024\t', '1048576'], ['1048576', '1073741824'],
  ])('converts ps KiB %j to bytes %s', (rss, expected) => {
    const result = fixture(path, 'rss_bytes_for_pid 101', rss);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`${expected}\n`);
  });
  it.each(['', ' ', '-1', '1.5', '1G', '1 2', '1\n2', 'RSS', '999999999999999999999999'])('rejects unknown/malformed RSS %j', rss => {
    const result = fixture(path, 'rss_bytes_for_pid 101', rss);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
  });
  it('rejects a failed ps even if it emitted a number', () => {
    const result = fixture(path, 'rss_bytes_for_pid 101', '1048576', '0', '1');
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
  });
  it('fails safely without action on an unknown measurement', () => {
    const result = fixture(path, 'run_once', 'bad', '0');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('fail-safe');
  });
});

it('preserves per-PID decisions in the resource guard and deduplicated stable/nightly aggregation in the standalone watchdog', () => {
  const perPid = fixture(watchdogPaths[0]!, 'run_once', '600000');
  expect(perPid.status, perPid.stderr).toBe(0);
  expect(perPid.stdout).toBe('');
  const aggregate = fixture(watchdogPaths[1]!, 'run_once', '600000');
  expect(aggregate.status, aggregate.stderr).toBe(0);
  expect(aggregate.stdout).toBe('decision:101 1228800000 0 rss\n');
});

it('preserves resource guard >= and standalone > threshold boundaries', () => {
  const perPid = fixture(watchdogPaths[0]!, 'run_once', '1048576', '0');
  expect(perPid.status, perPid.stderr).toBe(0);
  expect(perPid.stdout).toBe('decision:101 1073741824\n');
  const aggregate = fixture(watchdogPaths[1]!, 'run_once', '1048576', '0');
  expect(aggregate.status, aggregate.stderr).toBe(0);
  expect(aggregate.stdout).toBe('');
});

it.each(['0', '0.5', 'invalid'])('preserves the resource guard threshold floor for %s', threshold => {
  const result = fixture(watchdog, 'run_once', '1048576', '0', '0', threshold);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('refusing to run');
});

it('retains the independent compressor signal while marking unknown RSS explicitly', () => {
  const result = fixture(watchdogPaths[1]!, 'run_once', 'bad', '0', '0', '1', '3145729');
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe('decision:101 unknown 12884905984 compressor\n');
});

it('prohibits task-port commands throughout the shipped resource guard and sampler inventory', () => {
  const paths = [
    ...readdirSync(join(root, 'launchd/resource-guard')).filter(name => /\.(sh|c)$/.test(name))
      .map(name => `launchd/resource-guard/${name}`),
    ...watchdogPaths, 'launchd/cmux-ram-sampler/bin/cmux-ram-sampler.sh',
    'scripts/install-mcp-reaper.sh', 'src/mcp-reaper.ts', 'src/resource-guard.ts',
  ];
  const command = /(?:^|[|;(]|\b(?:exec|command|timeout|gtimeout))\s*(?:\/(?:usr\/)?(?:bin|sbin)\/)?(?:vmmap|footprint|sample|leaks|heap|lldb|gdb|debugserver|dtrace)\b|\b(?:task_for_pid|task_read_for_pid|task_inspect_for_pid|mach_vm_read|mach_vm_region|task_info)\b/;
  const findings = [...new Set(paths)].flatMap(path => readFileSync(join(root, path), 'utf8').split('\n')
    .flatMap((line, i) => !/^\s*#/.test(line) && command.test(line) ? [`${path}:${i + 1}: ${line.trim()}`] : []));
  expect(findings).toEqual([]);
});
