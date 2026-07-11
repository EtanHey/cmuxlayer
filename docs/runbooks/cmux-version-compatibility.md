# Internal cmux app compatibility record

Status: internal-only operational contract. Do not file or coordinate this
record upstream without a separate owner decision.

cmuxlayer's socket protocol and ancestry-sensitive behavior are currently tested
against:

- cmux `0.64.17` (production)
- cmux `0.64.14-nightly` (including build-qualified versions on that nightly line)

The executable record lives in `src/cmux-version-compatibility.ts`. Update that
record only after the real-cmux contract lane verifies socket calls, detached
orphan denial, list/read, doctor, and daemon retire/autostart behavior against
the candidate app version.

`cmuxlayer doctor` reads the selected app CLI's `--version` output when
available. A tested version emits `INFO`; an untested version emits `WARN` with
"behavior unverified". Compatibility never changes overall doctor health:
untested does not mean broken.

## Ancestry access-control finding

The real-cmux contract lane depends on cmux rejecting a detached, reparented
socket client with the observed `EPIPE`/errno-32 ancestry contract while allowing
pane-descended clients. This is retained as an internal compatibility finding,
not an upstream request. A change in that behavior is evidence to investigate
and update this record; it is not grounds to fail closed solely because the app
version is new.
