# Issue #645 captured Codex frame

Read-only capture from surface:1144 on 2026-09-15. `codex-frame.txt` preserves the frame, including misleading Claude text in scrollback, blank lines, and terminal home-path output (the home directory is written as `~`). Those paths are documentary data; no test uses them for filesystem access. The t2 delivery regression loads this fixture relative to the test file and uses the observed stable surface UUID in its fake topology.

The empty Codex hint must permit text delivery even though the scrollback parser infers Claude. A genuine draft or second human line must refuse mutation; key-Return without owned text must dispatch nothing.
