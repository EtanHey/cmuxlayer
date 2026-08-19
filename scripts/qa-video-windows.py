#!/usr/bin/env python3
"""Emit cmux's on-screen windows, front-to-back, as JSON.

AIDEV-NOTE: this exists because System Events / AXRaise proved unreliable for
this job — a freshly created cmux window is intermittently absent from the
accessibility window list entirely, which made the harness's isolation check
say "not frontmost" for a window that was plainly on top. CoreGraphics'
window list is the authority the window server itself uses: it needs no
Accessibility grant, it always sees the window, and it reports true front-to-
back order plus bounds, which is what "is anything covering the probe" needs.

Output: {"windows": [{"owner","name","bounds":{x,y,w,h},"layer"}, ...]} in
front-to-back order, on-screen windows only.
"""

import json
import sys

try:
    from Quartz import (
        CGDisplayBounds,
        CGDisplayCopyDisplayMode,
        CGDisplayModeGetPixelWidth,
        CGDisplayModeGetWidth,
        CGGetActiveDisplayList,
        CGMainDisplayID,
        CGWindowListCopyWindowInfo,
        kCGNullWindowID,
        kCGWindowListExcludeDesktopElements,
        kCGWindowListOptionOnScreenOnly,
    )
except ImportError:
    print(json.dumps({"error": "Quartz (pyobjc) unavailable"}))
    sys.exit(3)


def displays() -> list:
    """Active displays in CGGetActiveDisplayList order, with backing scale.

    avfoundation enumerates its "Capture screen N" inputs in this same order,
    so the list index is the capture device index -- but the harness still
    verifies that by comparing the recorded resolution against pixel_w/pixel_h
    rather than trusting the correspondence.
    """
    err, ids, count = CGGetActiveDisplayList(16, None, None)
    if err:
        return []
    main = CGMainDisplayID()
    out = []
    for index, display_id in enumerate(ids[:count]):
        bounds = CGDisplayBounds(display_id)
        mode = CGDisplayCopyDisplayMode(display_id)
        logical_w = CGDisplayModeGetWidth(mode) if mode else int(bounds.size.width)
        pixel_w = CGDisplayModeGetPixelWidth(mode) if mode else logical_w
        scale = (pixel_w / logical_w) if logical_w else 1
        out.append(
            {
                "index": index,
                "id": int(display_id),
                "main": int(display_id) == int(main),
                "scale": round(scale, 4),
                "bounds": {
                    "x": int(bounds.origin.x),
                    "y": int(bounds.origin.y),
                    "w": int(bounds.size.width),
                    "h": int(bounds.size.height),
                },
                "pixel_w": int(pixel_w),
                "pixel_h": int(round(bounds.size.height * scale)),
            }
        )
    return out


def main() -> int:
    options = kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements
    info = CGWindowListCopyWindowInfo(options, kCGNullWindowID) or []
    windows = []
    for entry in info:
        bounds = entry.get("kCGWindowBounds") or {}
        windows.append(
            {
                "id": int(entry.get("kCGWindowNumber", 0)),
                "owner": entry.get("kCGWindowOwnerName") or "",
                "name": entry.get("kCGWindowName") or "",
                "layer": entry.get("kCGWindowLayer", 0),
                "bounds": {
                    "x": int(bounds.get("X", 0)),
                    "y": int(bounds.get("Y", 0)),
                    "w": int(bounds.get("Width", 0)),
                    "h": int(bounds.get("Height", 0)),
                },
            }
        )
    print(json.dumps({"windows": windows, "displays": displays()}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
