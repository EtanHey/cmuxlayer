#!/usr/bin/env bash
# A staple is an offline ticket. Require intact signatures and Gatekeeper's
# notarization verdict even when that offline ticket is absent.
set -euo pipefail
export LC_ALL=C
app=${1:?app path required}
assessment=${2:?assessment receipt required}

codesign --verify --deep --strict "$app"
staple_status=0
xcrun stapler validate "$app" || staple_status=$?
if [ "$staple_status" -ne 0 ]; then
  printf '::notice::Staple validation exit %s; requiring Gatekeeper notarization assessment.\n' "$staple_status"
fi
spctl --assess --type execute --verbose=2 "$app" 2>&1 | tee "$assessment"
if ! grep -Fxq 'source=Notarized Developer ID' "$assessment"; then
  printf '::error::Gatekeeper did not attest Notarized Developer ID.\n' >&2
  exit 1
fi
