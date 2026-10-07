"""Private local PTY verification only. Does not launch cmux or a model CLI."""
import json, os, pty, select, subprocess, sys, tempfile, time
from pathlib import Path

cli, repository, node = sys.argv[1:]
with tempfile.TemporaryDirectory(prefix="xmac-fixture-pty-") as folder:
    root = Path(folder).resolve()
    for name in ("home", "state", "events"): (root / name).mkdir(mode=0o700)
    master, slave = pty.openpty()
    surface = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    env = dict(os.environ, CMUXLAYER_XMAC_FIXTURE_DIR=str(root),
               CMUXLAYER_HARNESS_HOME=str(root / "home"), CODEX_HOME=str(root / "home/.codex"),
               CMUXLAYER_STATE_DIR=str(root / "state"), CMUX_SURFACE_ID=surface,
               CMUXLAYER_SESSION_REGISTRY=str(root / "sessions.jsonl"))
    proc = subprocess.Popen([node, str(Path(repository)/"scripts/ratchet-fixture-tui.mjs"),
                             "xmac-"+cli, "unused"], stdin=slave, stdout=slave, stderr=slave, cwd=root, env=env)
    os.close(slave)
    frames = []
    def drain():
        while select.select([master], [], [], 0)[0]:
            chunk = os.read(master, 65536)
            if not chunk: break
            frames.append(chunk)
    def until(check):
        deadline = time.monotonic()+8
        while time.monotonic()<deadline:
            drain()
            if proc.poll() is not None: raise RuntimeError("fixture exited: "+b"".join(frames).decode())
            try:
                if check(): return
            except (FileNotFoundError, json.JSONDecodeError): pass
            time.sleep(.02)
        raise RuntimeError("fixture PTY evidence timed out")
    events = root / "events" / (surface+".json")
    try:
        until(events.exists)
        os.write(master, b"Reply exactly PTY_REPLY. Use no tools.\r")
        os.write(master, b"cmuxlayer contract for fixture: Read and follow /scratch/fixture/contract.md")
        until(lambda: json.loads(events.read_text())["replies"] == ["PTY_REPLY"])
        until(lambda: (root/"sessions.jsonl").exists())
        state = json.loads(events.read_text())
        registration = json.loads((root/"sessions.jsonl").read_text())
        transcript = Path(state["transcript"]).read_text()
        assert state["draft"].startswith("cmuxlayer contract for fixture")
        assert registration["pid"] == proc.pid and registration["surface_uuid"] == surface
        assert "PTY_REPLY" in transcript and "cmuxlayer contract for fixture" not in transcript
        drain()
        screen = b"".join(frames).decode().split("\x1b[2J\x1b[H")[-1]
        print(json.dumps(dict(state=state, registration=registration, transcript=transcript, screen=screen)))
    finally:
        proc.terminate()
        try: proc.wait(timeout=3)
        except subprocess.TimeoutExpired: proc.kill(); proc.wait(timeout=3)
        os.close(master)
