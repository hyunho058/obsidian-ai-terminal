#!/usr/bin/env python3
"""PTY bridge for Obsidian AI Terminal (standard library only, Python >= 3.9).

Usage: pty_bridge.py COLS ROWS COMMAND [ARGS...]

    fd 0  bytes for the program (written to the PTY unchanged); EOF stops the session
    fd 1  raw PTY output, unchanged
    fd 2  diagnostics; lines starting with "@@pty_bridge " carry one JSON event for the plugin:
            {"event": "started", "pid": N}
            {"event": "exec_failed", "command": "...", "errno": N, "code": "ENOENT", "message": "..."}
    fd 3  optional resize channel: lines "COLS,ROWS\\n" (partial lines are buffered)

Exit status: the program's exit code; 128+N if it was killed by signal N; 127 if the command was not found,
126 if it could not be executed (with an "exec_failed" event; nothing is printed into the PTY).

Shutdown is owned by this helper, so it also works when the plugin's process is gone. Triggers: EOF on
stdin, SIGTERM / SIGHUP / SIGINT to the helper, stdout closed, or the parent process dying (getppid()
checked every second). Then: SIGHUP (+ SIGCONT) to every process group of the program's session and to the
groups of its descendants that left the session (e.g. `setsid` / Node `detached` children), up to 3 s
grace, SIGKILL to whatever remains, reap, exit. When the program exits on its own, leftovers in its session
get the same SIGHUP -> 3 s -> SIGKILL treatment before the helper exits.

Not covered: processes that daemonized (double fork + setsid, e.g. a tmux server) - they are no longer
descendants and deliberately outlive the terminal, as with any terminal app - and setsid'd children that
were already re-parented to launchd when the program exited on its own.
"""

import errno
import fcntl
import json
import os
import pty
import select
import signal
import stat
import struct
import subprocess
import sys
import termios
import time

MARKER = "@@pty_bridge "
CONTROL_FD = 3
GRACE_SECONDS = 3.0
KILL_WAIT_SECONDS = 1.0
PARENT_POLL_SECONDS = 1.0
DRAIN_IDLE_SECONDS = 0.1
FLUSH_SECONDS = 2.0
HIGH_WATER = 1 << 18
READ_SIZE = 1 << 16
MAX_CONTROL_LINE = 256
# macOS kernel value; the termios module of Python 3.9 does not export it.
IUTF8 = getattr(termios, "IUTF8", 0x4000 if sys.platform == "darwin" else 0)
NOT_FOUND_ERRNOS = (errno.ENOENT, errno.ENOTDIR)


def emit(event, **fields):
    payload = {"event": event}
    payload.update(fields)
    try:
        os.write(2, (MARKER + json.dumps(payload) + "\n").encode("ascii"))
    except OSError:
        pass


def clamp_size(value):
    return max(1, min(int(value), 65535))


def parse_size(text):
    cols, rows = text.strip().split(",")
    return clamp_size(cols), clamp_size(rows)


def get_winsize(fd):
    rows, cols, _, _ = struct.unpack("HHHH", fcntl.ioctl(fd, termios.TIOCGWINSZ, b"\0" * 8))
    return cols, rows


def set_winsize(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def set_nonblocking(fd):
    flags = fcntl.fcntl(fd, fcntl.F_GETFL)
    fcntl.fcntl(fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)
    return flags


def exit_code_from_status(status):
    code = os.waitstatus_to_exitcode(status)
    return code if code >= 0 else 128 - code


def control_fd_available():
    try:
        mode = os.fstat(CONTROL_FD).st_mode
    except OSError:
        return False
    return stat.S_ISFIFO(mode) or stat.S_ISSOCK(mode) or stat.S_ISCHR(mode)


def list_processes():
    """[(pid, ppid, pgid)] for every process, or [] if `ps` fails."""
    try:
        out = subprocess.run(
            ["/bin/ps", "-A", "-o", "pid=,ppid=,pgid="],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=2,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    procs = []
    for line in out.decode("ascii", "replace").splitlines():
        parts = line.split()
        if len(parts) == 3:
            try:
                procs.append(tuple(int(p) for p in parts))
            except ValueError:
                pass
    return procs


def group_alive(pgid):
    try:
        os.killpg(pgid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        # Only zombies left (macOS answers EPERM for those) or not ours: nothing we can signal.
        return False
    except OSError:
        return False


def signal_groups(pgids, sig):
    for pgid in pgids:
        try:
            os.killpg(pgid, sig)
        except OSError:
            pass


def child_exec(argv, cols, rows, err_w):
    """Runs in the forked child (session leader, stdio = PTY slave). Never returns."""
    try:
        signal.set_wakeup_fd(-1)
        # Python ignores SIGPIPE/SIGXFSZ; ignored dispositions survive exec, handlers do not.
        for sig in (signal.SIGPIPE, signal.SIGXFSZ, signal.SIGTERM, signal.SIGHUP, signal.SIGINT, signal.SIGCHLD):
            signal.signal(sig, signal.SIG_DFL)
    except (OSError, ValueError):
        pass
    try:
        set_winsize(0, cols, rows)
    except OSError:
        pass
    if IUTF8:
        try:
            attrs = termios.tcgetattr(0)
            attrs[0] |= IUTF8
            termios.tcsetattr(0, termios.TCSANOW, attrs)
        except (OSError, termios.error):
            pass
    err = errno.ENOEXEC
    try:
        os.execvp(argv[0], argv)
    except OSError as e:
        err = e.errno or errno.ENOEXEC
    except ValueError:
        err = errno.ENOENT  # empty command
    except BaseException:
        pass
    try:
        os.write(err_w, str(err).encode("ascii"))
    except OSError:
        pass
    os._exit(127 if err in NOT_FOUND_ERRNOS else 126)


class Bridge:
    def __init__(self, pid, master, control_fd, wake_r, parent_pid):
        self.pid = pid
        self.master = master
        self.control_fd = control_fd
        self.wake_r = wake_r
        self.parent_pid = parent_pid
        self.status = None
        self.to_pty = bytearray()
        self.to_out = bytearray()
        self.control_buf = b""
        self.stdin_open = True
        self.master_open = True
        self.out_broken = False
        self.stop_signal = None
        self.saved_flags = {}

    # -- process state -------------------------------------------------------------------------------

    def reap(self):
        if self.status is None:
            try:
                pid, status = os.waitpid(self.pid, os.WNOHANG)
            except ChildProcessError:
                return True
            if pid == self.pid:
                self.status = status
        return self.status is not None

    def exit_code(self):
        if self.status is None:
            return 128 + signal.SIGKILL
        return exit_code_from_status(self.status)

    def on_stop_signal(self, signum, _frame):
        if self.stop_signal is None:
            self.stop_signal = signum

    def stop_reason(self):
        if self.stop_signal is not None:
            return "signal %d" % self.stop_signal
        if not self.stdin_open:
            return "stdin closed"
        if self.out_broken:
            return "stdout closed"
        if os.getppid() != self.parent_pid:
            return "parent exited"
        return None

    def targets(self, include_descendants):
        """Process groups to signal: the program's session plus (optionally) its descendants' groups."""
        sid = self.pid
        pgids = {sid}
        try:
            pgids.add(os.tcgetpgrp(self.master))
        except OSError:
            pass
        children = {}
        for pid, ppid, pgid in list_processes():
            children.setdefault(ppid, []).append((pid, pgid))
            try:
                if os.getsid(pid) == sid:
                    pgids.add(pgid)
            except OSError:
                pass
        if include_descendants and self.status is None:
            stack, seen = [self.pid], {self.pid}
            while stack:
                for pid, pgid in children.get(stack.pop(), ()):
                    if pid not in seen:
                        seen.add(pid)
                        pgids.add(pgid)
                        stack.append(pid)
        pgids.discard(os.getpgrp())
        pgids.discard(0)
        pgids.discard(1)
        return pgids

    # -- I/O -----------------------------------------------------------------------------------------

    def setup_fds(self):
        for fd in (1, self.master):
            try:
                self.saved_flags[fd] = set_nonblocking(fd)
            except OSError:
                pass

    def restore_fds(self):
        flags = self.saved_flags.get(1)
        if flags is not None:
            try:
                fcntl.fcntl(1, fcntl.F_SETFL, flags)
            except OSError:
                pass

    def read_master(self):
        try:
            data = os.read(self.master, READ_SIZE)
        except BlockingIOError:
            return True
        except OSError:
            data = b""
        if not data:
            self.master_open = False
            return False
        if not self.out_broken:
            self.to_out += data
        return True

    def write_out(self):
        if not self.to_out:
            return
        try:
            n = os.write(1, self.to_out)
            del self.to_out[:n]
        except BlockingIOError:
            pass
        except OSError:
            self.out_broken = True
            self.to_out.clear()

    def write_pty(self):
        if not self.to_pty:
            return
        try:
            n = os.write(self.master, self.to_pty)
            del self.to_pty[:n]
        except BlockingIOError:
            pass
        except OSError:
            self.to_pty.clear()

    def read_stdin(self):
        try:
            data = os.read(0, READ_SIZE)
        except BlockingIOError:
            return
        except OSError:
            data = b""
        if data:
            self.to_pty += data
        else:
            self.stdin_open = False

    def read_control(self):
        try:
            data = os.read(self.control_fd, 4096)
        except BlockingIOError:
            return
        except OSError:
            data = b""
        if not data:
            self.control_fd = None
            return
        buf = self.control_buf + data
        *lines, rest = buf.split(b"\n")
        self.control_buf = rest if len(rest) <= MAX_CONTROL_LINE else b""
        size = None
        for line in lines:
            try:
                size = parse_size(line.decode("ascii"))
            except (ValueError, UnicodeDecodeError):
                pass
        if size is not None:
            self.resize(*size)

    def resize(self, cols, rows):
        try:
            changed = get_winsize(self.master) != (cols, rows)
            set_winsize(self.master, cols, rows)
        except OSError:
            return
        if changed:
            return  # the kernel sends SIGWINCH to the foreground process group itself
        # Same size: no kernel signal, so send one explicitly (a redraw request).
        try:
            pgid = os.tcgetpgrp(self.master)
        except OSError:
            pgid = self.pid
        try:
            os.killpg(pgid, signal.SIGWINCH)
        except OSError:
            pass

    def drain_wake(self):
        try:
            while os.read(self.wake_r, 512):
                pass
        except OSError:
            pass

    def pump(self, timeout, relay_input):
        """One select round: PTY -> stdout always; stdin/control -> PTY only while relaying."""
        rlist = [self.wake_r]
        wlist = []
        if self.master_open and len(self.to_out) < HIGH_WATER:
            rlist.append(self.master)
        if relay_input:
            if self.stdin_open and len(self.to_pty) < HIGH_WATER:
                rlist.append(0)
            if self.control_fd is not None:
                rlist.append(self.control_fd)
            if self.to_pty and self.master_open:
                wlist.append(self.master)
        if self.to_out and not self.out_broken:
            wlist.append(1)
        try:
            readable, writable, _ = select.select(rlist, wlist, [], max(0.0, timeout))
        except (OSError, ValueError):
            return False
        got_output = False
        if self.wake_r in readable:
            self.drain_wake()
        if self.master in readable:
            got_output = self.read_master()
        if 0 in readable:
            self.read_stdin()
        if self.control_fd is not None and self.control_fd in readable:
            self.read_control()
        if self.master in writable:
            self.write_pty()
        if 1 in writable:
            self.write_out()
        return got_output

    # -- phases --------------------------------------------------------------------------------------

    def relay(self):
        """Relays until the program exits (returns None) or a stop trigger fires (returns its reason)."""
        while True:
            if self.reap():
                return None
            reason = self.stop_reason()
            if reason:
                return reason
            self.pump(PARENT_POLL_SECONDS, relay_input=True)

    def drain(self, max_seconds):
        """Forwards remaining PTY output until EOF, a quiet period, or `max_seconds`."""
        deadline = time.monotonic() + max_seconds
        idle_since = time.monotonic()
        while self.master_open and time.monotonic() < deadline:
            if self.pump(DRAIN_IDLE_SECONDS, relay_input=False):
                idle_since = time.monotonic()
            elif time.monotonic() - idle_since >= DRAIN_IDLE_SECONDS:
                break

    def terminate(self, include_descendants):
        targets = self.targets(include_descendants)
        if self.status is not None:
            targets = {g for g in targets if group_alive(g)}
            if not targets:
                return
        signal_groups(targets, signal.SIGHUP)
        signal_groups(targets, signal.SIGCONT)
        deadline = time.monotonic() + GRACE_SECONDS
        while time.monotonic() < deadline:
            self.pump(0.05, relay_input=False)
            self.reap()
            if self.status is not None and not any(group_alive(g) for g in targets):
                return
        targets |= self.targets(include_descendants)
        signal_groups(targets, signal.SIGKILL)
        deadline = time.monotonic() + KILL_WAIT_SECONDS
        while self.status is None and time.monotonic() < deadline:
            self.pump(0.02, relay_input=False)
            self.reap()

    def flush(self):
        deadline = time.monotonic() + FLUSH_SECONDS
        while self.to_out and not self.out_broken and time.monotonic() < deadline:
            try:
                _, writable, _ = select.select([], [1], [], 0.1)
            except (OSError, ValueError):
                break
            if writable:
                self.write_out()

    def run(self):
        self.setup_fds()
        try:
            reason = self.relay()
            if reason is None:
                self.drain(1.0)
                self.terminate(include_descendants=False)
            else:
                self.terminate(include_descendants=True)
            self.drain(0.5)
            self.flush()
            return self.exit_code()
        except BaseException:
            if self.status is None:
                signal_groups(self.targets(include_descendants=True), signal.SIGKILL)
            raise
        finally:
            self.restore_fds()


def main(argv):
    if len(argv) < 4:
        sys.stderr.write("usage: pty_bridge.py COLS ROWS COMMAND [ARGS...]\n")
        return 2
    try:
        cols, rows = clamp_size(argv[1]), clamp_size(argv[2])
    except ValueError:
        sys.stderr.write("pty_bridge: COLS and ROWS must be integers\n")
        return 2
    command = argv[3:]
    control_fd = CONTROL_FD if control_fd_available() else None
    if control_fd is not None:
        os.set_inheritable(control_fd, False)
    parent_pid = os.getppid()

    wake_r, wake_w = os.pipe()
    set_nonblocking(wake_r)
    set_nonblocking(wake_w)
    signal.set_wakeup_fd(wake_w)
    bridge_ref = []

    def on_stop(signum, frame):
        if bridge_ref:
            bridge_ref[0].on_stop_signal(signum, frame)
        else:
            pending_stop.append(signum)

    pending_stop = []
    for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        signal.signal(sig, on_stop)
    signal.signal(signal.SIGCHLD, lambda _s, _f: None)

    err_r, err_w = os.pipe()
    pid, master = pty.fork()
    if pid == 0:
        os.close(err_r)
        child_exec(command, cols, rows, err_w)
    os.close(err_w)
    report = b""
    while True:
        chunk = os.read(err_r, 64)
        if not chunk:
            break
        report += chunk
    os.close(err_r)

    if report:
        try:
            err = int(report)
        except ValueError:
            err = errno.ENOEXEC
        os.waitpid(pid, 0)
        os.close(master)
        emit(
            "exec_failed",
            command=command[0],
            errno=err,
            code=errno.errorcode.get(err, "E%d" % err),
            message=os.strerror(err),
        )
        return 127 if err in NOT_FOUND_ERRNOS else 126

    emit("started", pid=pid)
    bridge = Bridge(pid, master, control_fd, wake_r, parent_pid)
    bridge_ref.append(bridge)
    if pending_stop:
        bridge.stop_signal = pending_stop[0]
    return bridge.run()


if __name__ == "__main__":
    sys.exit(main(sys.argv))
