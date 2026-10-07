import json, os, pty, select, subprocess, sys, time

# Exact native anchor argv, actual PTY/startup. The input only observes routing
# and explicitly invokes the owned Node helper's non-executing preflight.
master, slave = pty.openpty()
child = subprocess.Popen(['/bin/zsh', '-l'], stdin=slave, stdout=slave, stderr=slave,
                         env=json.loads(sys.argv[1]), cwd=sys.argv[2])
os.close(slave)
output = bytearray()
try:
    os.write(master, (sys.argv[3] + '\nexit\n').encode())
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if select.select([master], [], [], .1)[0]:
            try: output.extend(os.read(master, 65536))
            except OSError: break
        if child.poll() is not None: break
    if child.poll() is None: raise RuntimeError('owned shell did not exit')
    print(json.dumps({'argv': ['/bin/zsh', '-l'], 'pid': child.pid,
                      'status': child.returncode, 'screen': output.decode(errors='replace')}))
finally:
    if child.poll() is None: child.terminate(); child.wait(timeout=5)
    os.close(master)
