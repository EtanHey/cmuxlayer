"""Read-only Darwin libproc evidence. Internal protocol; never a GC authorization."""
import ctypes as C
import errno
import json
import os
import sys


class BSD(C.Structure):
    _fields_ = [(n, C.c_uint32) for n in (
        "flags status xstatus pid ppid uid gid ruid rgid svuid svgid reserved".split())] + [
        ("comm", C.c_char * 16), ("name", C.c_char * 32)] + [
        (n, C.c_uint32) for n in "nfiles pgid pjobc tdev tpgid".split()] + [
        ("nice", C.c_int32), ("seconds", C.c_uint64), ("microseconds", C.c_uint64)]


class Stat(C.Structure):
    _fields_ = [("dev", C.c_uint32), ("mode", C.c_uint16), ("nlink", C.c_uint16),
                ("ino", C.c_uint64), ("uid", C.c_uint32), ("gid", C.c_uint32)] + [
        (n, C.c_int64) for n in "atime atimens mtime mtimens ctime ctimens birth birthns size blocks".split()] + [
        ("blksize", C.c_int32), ("flags", C.c_uint32), ("gen", C.c_uint32),
        ("rdev", C.c_uint32), ("spare", C.c_int64 * 2)]


class Vnode(C.Structure):
    _fields_ = [("stat", Stat), ("type", C.c_int32), ("pad", C.c_int32), ("fsid", C.c_int32 * 2)]


class PathInfo(C.Structure):
    _fields_ = [("vnode", Vnode), ("path", C.c_char * 1024)]


class Cwd(C.Structure):
    _fields_ = [("current", PathInfo), ("root", PathInfo)]


def collect_owner(uid, lib=None, actual_uid=None):
    result = dict(before=None, after=None, processes=[], reason=None, membershipReads=[])
    def unavailable(code):
        result["reason"] = code
        return result
    if type(uid) is not int or not 0 <= uid <= 0xffffffff or uid != (os.getuid() if actual_uid is None else actual_uid):
        return unavailable("OWNER_UID_MISMATCH")
    if lib is None:
        if sys.platform != "darwin": return unavailable("UNSUPPORTED_PLATFORM")
        try: lib = C.CDLL("/usr/lib/libproc.dylib", use_errno=True)
        except OSError: return unavailable("LIBPROC_UNAVAILABLE")
        try:
            lib.proc_listpids.argtypes = [C.c_uint32, C.c_uint32, C.c_void_p, C.c_int]
            lib.proc_pidinfo.argtypes = [C.c_int, C.c_int, C.c_uint64, C.c_void_p, C.c_int]
            lib.proc_listpids.restype = lib.proc_pidinfo.restype = C.c_int
        except AttributeError: return unavailable("LIBPROC_API_UNAVAILABLE")
    if not all(callable(getattr(lib, n, None)) for n in ("proc_listpids", "proc_pidinfo")):
        return unavailable("LIBPROC_API_UNAVAILABLE")
    if C.sizeof(C.c_void_p) != 8 or (C.sizeof(BSD), C.sizeof(Cwd), BSD.seconds.offset, PathInfo.path.offset) != (136, 2352, 120, 152):
        return unavailable("UNSUPPORTED_ABI")

    # One query + one fill per endpoint, 256 spare PID slots, 16MiB allocation ceiling.
    # Saturation refuses completeness; this is not a capped successful selector.
    def membership(operation):
        C.set_errno(0); required = lib.proc_listpids(4, uid, None, 0); error = C.get_errno()
        item = dict(operation=operation, observedPids=[], membership=None, queryBytes=required,
                    bytes=None, capacityBytes=None, errno=error, reason=None, invalidEntries=[])
        result["membershipReads"].append(item)
        if error or required <= 0 or required % 4 or required > 16 * 1024 * 1024 - 1024:
            item["reason"] = "ENUMERATION_QUERY_INVALID"
        else:
            capacity = required + 1024; buffer = (C.c_int * (capacity // 4))()
            C.set_errno(0); count = lib.proc_listpids(4, uid, buffer, capacity); item["errno"] = C.get_errno()
            item.update(bytes=count, capacityBytes=capacity)
            entries = buffer[:max(0, min(count, capacity)) // 4]
            item["observedPids"] = [pid for pid in entries if pid > 0]
            item["invalidEntries"] = [dict(index=i, value=pid) for i, pid in enumerate(entries) if pid <= 0]
            if item["errno"] or count <= 0 or count % 4 or count >= capacity or not item["observedPids"] or item["invalidEntries"] or len(set(item["observedPids"])) != len(item["observedPids"]):
                item["reason"] = "ENUMERATION_SATURATED" if count >= capacity else "ENUMERATION_READ_INVALID"
            else: item["membership"] = item["observedPids"]
        if item["reason"]: result["reason"] = "MEMBERSHIP_UNOBSERVED"
        return item

    def probe(pid):
        errors, failures = [], []
        def fail(operation, code, error, identity, count=None, expected=None):
            errors.append(code)
            failures.append(dict(operation=operation, errno=error, identity=dict(identity) if identity else None,
                                 reason=code, bytes=count, expectedBytes=expected))
        def observed_errno(operation, error, identity, count, expected):
            # The symbol names the observed errno, NOT a proved failed syscall.
            # Preserve its independent full/short byte result with explicit semantics.
            errors.append(errno.errorcode.get(error, "OBSERVED_ERRNO"))
            failures.append(dict(operation=operation, errno=error, identity=dict(identity),
                                 reason="OBSERVED_ERRNO", bytes=count, expectedBytes=expected))
        def read(flavor, cls, operation):
            buffer = cls(); expected = C.sizeof(buffer)
            C.set_errno(0); count = lib.proc_pidinfo(pid, flavor, 0, C.byref(buffer), expected)
            return buffer, count, expected, C.get_errno()
        def identity(operation, prior=None):
            b, count, expected, error = read(3, BSD, operation)
            def field(name):
                size = C.sizeof(dict(BSD._fields_)[name])
                return getattr(b, name) if 0 < count <= expected and getattr(BSD, name).offset + size <= count else None
            actual = field("pid")
            value = dict(pid=pid if actual is None else actual, ppid=field("ppid"), uid=field("uid"),
                         startSeconds=None, startMicroseconds=None, cwd=None)
            for name, key in (("seconds", "startSeconds"), ("microseconds", "startMicroseconds")):
                raw = field(name); value[key] = str(raw) if raw is not None else None
            if count != expected:
                code = errno.errorcode.get(error, "SHORT_READ") if count <= 0 and error else "SHORT_READ"
                fail(operation, code, error, prior or (value if count > 0 else None), count, expected)
            if count > 0 and error: observed_errno(operation, error, value, count, expected)
            if actual is not None and actual != pid: fail(operation, "PID_MISMATCH", 0, value)
            if value["uid"] is not None and value["uid"] != uid: fail(operation, "UID_MISMATCH", 0, value)
            if field("seconds") == 0 or (field("microseconds") is not None and field("microseconds") >= 1000000):
                fail(operation, "INVALID_START", 0, value)
            return value
        def directory(operation, value, prior=None):
            b, count, expected, error = read(9, Cwd, operation)
            if count != expected:
                code = errno.errorcode.get(error, "SHORT_READ") if count <= 0 and error else "SHORT_READ"
                context = value if all(value[k] is not None for k in ("uid", "startSeconds", "startMicroseconds")) else prior or value
                fail(operation, code, error, context, count, expected)
            length = min(1024, max(0, count - PathInfo.path.offset)) if count <= expected else 0
            raw = C.string_at(C.addressof(b) + PathInfo.path.offset, length)
            try:
                path = raw[:raw.index(b"\0")].decode("utf-8", "strict")
                if not path.startswith("/"): raise ValueError()
                value["cwd"] = path
            except (ValueError, UnicodeError):
                if count > 0: fail(operation, "INVALID_CWD", 0, value, count, expected)
            if count > 0 and error: observed_errno(operation, error, value, count, expected)
        before = identity("identity-before"); directory("cwd-before", before)
        after = identity("identity-after", before); directory("cwd-after", after, before)
        if all(before[k] is not None and after[k] is not None for k in ("startSeconds", "startMicroseconds", "uid")) and any(before[k] != after[k] for k in ("pid", "ppid", "uid", "startSeconds", "startMicroseconds")):
            fail("identity-after", "IDENTITY_CHANGED", 0, after)
        if before["cwd"] is not None and after["cwd"] is not None and before["cwd"] != after["cwd"]:
            fail("cwd-after", "CWD_CHANGED", 0, after)
        return dict(before, pid=pid, identityAfter=after, sessionId=None, errors=errors, failures=failures)

    before = membership("membership-before"); result["before"] = before["membership"]
    result["processes"] = [probe(pid) for pid in dict.fromkeys(before["observedPids"])]
    after = membership("membership-after"); result["after"] = after["membership"]
    for pid in set(after["observedPids"]) - set(before["observedPids"]):
        result["processes"].append(dict(pid=pid, ppid=None, uid=None, startSeconds=None, startMicroseconds=None,
            cwd=None, identityAfter=None, sessionId=None, errors=["NOT_PROBED"],
            failures=[dict(operation="membership-after", errno=None, identity=None, reason="NOT_PROBED", bytes=None, expectedBytes=None)]))
    return result


if __name__ == "__main__":
    try: result = collect_owner(int(sys.argv[1]))
    except (ValueError, IndexError, OSError):
        result = dict(before=None, after=None, processes=[], reason="HELPER_FAILURE", membershipReads=[])
    print(json.dumps(result, ensure_ascii=True))
