#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

bash -x "$ROOT_DIR/tests/cmux-memory-watchdog.sh"
