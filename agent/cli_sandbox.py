"""Linux-only job boundary for a dedicated Relaydesk worker container."""
import ctypes
import errno
import os
from pathlib import Path
import platform
import resource
import signal
import subprocess
import time

UID = 10001
LIBC = ctypes.CDLL(None, use_errno=True)
READ = (1 << 2) | (1 << 3)  # READ_FILE | READ_DIR
EXEC = 1
WRITE_FILE = 1 << 1
TRUNCATE = 1 << 14


class Ruleset(ctypes.Structure):
    _fields_ = [('fs', ctypes.c_uint64)]


class PathRule(ctypes.Structure):
    _pack_ = 1
    _fields_ = [('access', ctypes.c_uint64), ('parent_fd', ctypes.c_int32)]


def checked(result):
    if result < 0:
        raise OSError(ctypes.get_errno(), 'Linux job isolation unavailable')
    return result


def abi_version():
    if platform.system() != 'Linux' or platform.machine() not in ('x86_64', 'aarch64'):
        raise ValueError('Use the Linux amd64/arm64 worker image')
    abi = checked(LIBC.syscall(444, 0, 0, 1))  # LANDLOCK_CREATE_RULESET_VERSION
    if abi < 3:
        raise ValueError('Linux Landlock ABI 3 or newer is required')
    return abi


def enable_supervisor():
    if os.geteuid() != 0:
        raise ValueError('The supervisor requires container UID 0')
    abi_version()
    checked(LIBC.prctl(36, 1, 0, 0, 0))  # PR_SET_CHILD_SUBREAPER


def restrict(writable):
    """Called only in a single-threaded fork child before exec; fail closed."""
    abi = abi_version()
    os.setgroups([])
    os.setgid(UID)
    os.setuid(UID)
    checked(LIBC.prctl(38, 1, 0, 0, 0))  # PR_SET_NO_NEW_PRIVS
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    # Include REFER, TRUNCATE and, when supported, IOCTL_DEV.
    handled = (1 << (16 if abi >= 5 else 15)) - 1
    attr = Ruleset(handled)
    rules = checked(LIBC.syscall(444, ctypes.byref(attr), ctypes.sizeof(attr), 0))

    def allow(path, access):
        fd = os.open(path, os.O_PATH | os.O_CLOEXEC)
        try:
            rule = PathRule(access, fd)
            checked(LIBC.syscall(445, rules, 1, ctypes.byref(rule), 0))
        finally:
            os.close(fd)

    try:
        for path in ('/usr', '/bin', '/sbin', '/lib', '/lib64'):
            if os.path.exists(path):
                allow(path, READ | EXEC)
        allow('/proc', READ)
        for path in ('/etc/ssl/certs', '/etc/ssl/openssl.cnf', '/etc/ld.so.cache', '/etc/resolv.conf', '/etc/hosts',
                     '/etc/nsswitch.conf', '/etc/passwd', '/etc/group', '/etc/localtime',
                     '/etc/services', '/etc/gai.conf'):
            if os.path.exists(path):
                allow(path, READ if os.path.isdir(path) else 1 << 2)
        for path in ('/dev/null', '/dev/zero', '/dev/random', '/dev/urandom'):
            allow(path, (1 << 2) | WRITE_FILE | TRUNCATE)
        # No creating device nodes; do not grant IOCTL_DEV over the writable tree.
        allow(writable, ((1 << 15) - 1) & ~((1 << 6) | (1 << 11)))
        checked(LIBC.syscall(446, rules, 0))
    finally:
        os.close(rules)


def reap(proc):
    """Also collect helpers which daemonized or started new process groups."""
    if proc.poll() is None:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        except OSError:
            raise SystemExit('Cannot stop job process group; stopping worker') from None
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            raise SystemExit('Cannot reap job process; stopping worker') from None
    if platform.system() != 'Linux':  # Portable subprocess tests only.
        return
    children = Path(f'/proc/self/task/{os.getpid()}/children')
    until = time.monotonic() + 5
    while True:
        try:
            if os.waitpid(-1, os.WNOHANG)[0]:
                continue
        except ChildProcessError:
            return
        for pid in children.read_text().split():
            try:
                os.kill(int(pid), signal.SIGKILL)
            except ProcessLookupError:
                pass
        if time.monotonic() >= until:
            # Do not accept another job with the same UID if isolation is uncertain.
            raise SystemExit('Cannot reap job descendants; stopping worker')
        time.sleep(.02)
