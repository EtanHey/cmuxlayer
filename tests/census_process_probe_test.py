import ctypes as C
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("probe", Path(__file__).parents[1] / "scripts/census-process-probe.py")
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


def bsd(pid=42, uid=501, usec=10):
    b = p.BSD(pid=pid, ppid=7, uid=uid, seconds=123, microseconds=usec)
    b.comm = b"PRIVATE_NAME"
    return b


def cwd(path=b"/synthetic"):
    v = p.Cwd()
    v.current.path = path
    return v


class Fake:
    def __init__(self):
        self.calls = []
        self.enums = [[42], [42]]
        self.reads = {3: [(bsd(), 136, 0), (bsd(), 136, 0)], 9: [(cwd(), 2352, 0), (cwd(), 2352, 0)]}

    def proc_listpids(self, kind, uid, buffer, size):
        self.calls.append(("list", kind, uid, size))
        assert (kind, uid) == (4, 501)
        value = self.enums[0]
        C.set_errno(0)
        if buffer is None:
            if value == "EPERM":
                self.enums.pop(0); C.set_errno(1); return 0
            return 4
        self.enums.pop(0)
        C.memmove(buffer, C.byref(C.c_int(42)), 4)
        return size if value == "SATURATED" else 3 if value == "SHORT" else 4

    def proc_pidinfo(self, pid, flavor, arg, buffer, size):
        self.calls.append(("info", pid, flavor, arg, size))
        assert (pid, arg) == (42, 0)
        value, count, error = self.reads[flavor].pop(0)
        C.set_errno(error)
        C.memmove(buffer, C.byref(value), min(size, max(0, count)))
        return count


class Evidence(unittest.TestCase):
    def scan(self, fake=None):
        return p.collect_owner(501, fake or Fake(), actual_uid=501)

    def test_exact_identity_cwd_and_no_names(self):
        f = Fake(); result = self.scan(f); row = result["processes"][0]
        self.assertEqual((row["pid"], row["ppid"], row["uid"], row["startSeconds"], row["startMicroseconds"], row["cwd"]), (42, 7, 501, "123", "10", "/synthetic"))
        self.assertEqual(row["identityAfter"]["cwd"], "/synthetic")
        self.assertEqual(row["failures"], [])
        self.assertNotIn("PRIVATE", json.dumps(result))
        self.assertEqual([c[2] for c in f.calls if c[0] == "info"], [3, 9, 3, 9])

    def test_reuse_and_cwd_change_preserve_both(self):
        f = Fake(); f.reads[3][1] = (bsd(usec=11), 136, 0); f.reads[9][1] = (cwd(b"/changed"), 2352, 0)
        row = self.scan(f)["processes"][0]
        self.assertEqual(row["startMicroseconds"], "10")
        self.assertEqual(row["identityAfter"]["startMicroseconds"], "11")
        self.assertEqual(row["identityAfter"]["cwd"], "/changed")
        self.assertIn("IDENTITY_CHANGED", row["errors"])
        self.assertIn("CWD_CHANGED", row["errors"])

    def test_esrch_context_known_and_unknown(self):
        for phase in (0, 1):
            f = Fake(); f.reads[3][phase] = (bsd(), 0, 3)
            row = self.scan(f)["processes"][0]
            failure = next(x for x in row["failures"] if x["errno"] == 3)
            self.assertEqual(failure["operation"], "identity-before" if phase == 0 else "identity-after")
            self.assertEqual(failure["identity"] is None, phase == 0)
            self.assertIn("ESRCH", row["errors"])

    def test_permission_short_and_invalid_values(self):
        for flavor, value, count, error, code in [(3, bsd(), 20, 0, "SHORT_READ"), (9, cwd(), 0, 1, "EPERM"), (3, bsd(uid=502), 136, 0, "UID_MISMATCH"), (3, bsd(usec=1000000), 136, 0, "INVALID_START"), (9, cwd(b"relative"), 2352, 0, "INVALID_CWD")]:
            f = Fake(); f.reads[flavor][0] = (value, count, error)
            row = self.scan(f)["processes"][0]
            self.assertIn(code, row["errors"])
            if count == 20: self.assertIsNone(row["uid"]); self.assertIsNone(row["startSeconds"])
            if flavor == 9: self.assertIsNone(row["cwd"])

    def test_unobserved_membership_is_null_with_partial_refs(self):
        for fault in ("EPERM", "SATURATED", "SHORT"):
            f = Fake(); f.enums[0] = fault; result = self.scan(f)
            self.assertIsNone(result["before"])
            self.assertIsNotNone(result["reason"])
            self.assertEqual(result["membershipReads"][0]["operation"], "membership-before")
            if fault == "SATURATED": self.assertEqual(result["membershipReads"][0]["observedPids"], [42])

    def test_platform_library_api_uid_fail_closed(self):
        self.assertEqual(p.collect_owner(502, Fake(), actual_uid=501)["reason"], "OWNER_UID_MISMATCH")
        with patch.object(p.sys, "platform", "unsupported"):
            self.assertEqual(p.collect_owner(501, actual_uid=501)["reason"], "UNSUPPORTED_PLATFORM")
        with patch.object(p.C, "CDLL", side_effect=OSError):
            self.assertEqual(p.collect_owner(501, actual_uid=501)["reason"], "LIBPROC_UNAVAILABLE")
        self.assertEqual(self.scan(object())["reason"], "LIBPROC_API_UNAVAILABLE")

    def test_short_cwd_retains_available_path_and_actual_byte_count(self):
        f = Fake(); f.reads[9][0] = (cwd(), 1176, 0)
        row = self.scan(f)["processes"][0]
        self.assertEqual(row["cwd"], "/synthetic")
        self.assertEqual(row["failures"][0]["bytes"], 1176)
        self.assertEqual(row["failures"][0]["expectedBytes"], 2352)

    def test_cwd_esrch_context_uses_latest_captured_replacement(self):
        f = Fake(); f.reads[3][1] = (bsd(usec=11), 136, 0); f.reads[9][1] = (cwd(), 0, 3)
        row = self.scan(f)["processes"][0]
        self.assertEqual(next(x for x in row["failures"] if x["errno"] == 3)["identity"]["startMicroseconds"], "11")

    def test_new_and_departed_members_remain_observations(self):
        f = Fake(); original = f.proc_listpids
        def listpids(kind, uid, buffer, size):
            count = original(kind, uid, buffer, size)
            if buffer is not None and not f.enums: C.memmove(buffer, C.byref(C.c_int(99)), 4)
            return count
        f.proc_listpids = listpids; result = self.scan(f)
        self.assertEqual((result["before"], result["after"]), ([42], [99]))
        self.assertEqual([r["pid"] for r in result["processes"]], [42, 99])
        self.assertIn("NOT_PROBED", result["processes"][1]["errors"])

    def test_full_byte_result_and_observed_errno_are_independent(self):
        for flavor, operation, expected in [(3, "identity-before", 136), (9, "cwd-before", 2352)]:
            f = Fake(); value, count, _ = f.reads[flavor][0]; f.reads[flavor][0] = (value, count, 1)
            row = self.scan(f)["processes"][0]; witness = row["failures"][0]
            self.assertEqual((witness["operation"], witness["errno"], witness["bytes"], witness["expectedBytes"]), (operation, 1, expected, expected))
            self.assertEqual(witness["reason"], "OBSERVED_ERRNO")  # not a proved EPERM syscall failure
            self.assertEqual((row["uid"], row["startSeconds"], row["cwd"]), (501, "123", "/synthetic"))
            if flavor == 9: self.assertEqual(witness["identity"]["cwd"], "/synthetic")

    def test_invalid_membership_preserves_values_indexes_and_valid_processes(self):
        f = Fake(); original = f.proc_listpids
        def listpids(kind, uid, buffer, size):
            if buffer is None: C.set_errno(0); return 8
            original(kind, uid, buffer, size); C.memmove(buffer, (C.c_int * 2)(42, -7), 8); return 8
        f.proc_listpids = listpids; result = self.scan(f)
        self.assertIsNone(result["before"]); self.assertIsNone(result["after"])
        self.assertEqual(result["membershipReads"][0]["invalidEntries"], [{"index": 1, "value": -7}])
        self.assertEqual(result["processes"][0]["pid"], 42)


if __name__ == "__main__": unittest.main()
