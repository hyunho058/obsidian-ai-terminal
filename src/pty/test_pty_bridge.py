"""Tests for pty_bridge.py (R2.2, R2.3, R2.4, R2.6, R7.1, R7.2). Runs on Python 3.9 and 3.14."""
import errno
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import textwrap
import threading
import time
import unittest

HELPER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pty_bridge.py")
PY = sys.executable

# Maps the pipe given as argv[1] onto fd 3 (the resize channel), then execs the helper.
LAUNCH = textwrap.dedent(
    """
    import os, sys
    fd = int(sys.argv[1])
    os.dup2(fd, 3)
    if fd != 3:
        os.close(fd)
    os.execv(sys.executable, [sys.executable] + sys.argv[2:])
    """
)


def alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    out = subprocess.run(["/bin/ps", "-o", "stat=", "-p", str(pid)], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL).stdout
    state = out.decode().strip()
    return bool(state) and not state.startswith("Z")


def wait_until(predicate, timeout, interval=0.05):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return predicate()


class Collector(threading.Thread):
    def __init__(self, stream):
        super().__init__(daemon=True)
        self.stream = stream
        self.data = bytearray()
        self.lock = threading.Lock()
        self.start()

    def run(self):
        while True:
            chunk = os.read(self.stream.fileno(), 65536)
            if not chunk:
                return
            with self.lock:
                self.data += chunk

    def snapshot(self):
        with self.lock:
            return bytes(self.data)

    def wait_for(self, needle, timeout=10.0):
        if isinstance(needle, str):
            needle = needle.encode()
        if not wait_until(lambda: needle in self.snapshot(), timeout):
            raise AssertionError("timed out waiting for %r; got %r" % (needle, self.snapshot()[-400:]))
        return self.snapshot()


class Bridge:
    def __init__(self, command, cols=100, rows=30, control=True):
        self.control = None
        pass_fds = ()
        if control:
            r, w = os.pipe()
            args = [PY, "-c", LAUNCH, str(r), "-I", HELPER, str(cols), str(rows)] + command
            pass_fds = (r,)
        else:
            args = [PY, "-I", HELPER, str(cols), str(rows)] + command
        self.proc = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, pass_fds=pass_fds)
        if control:
            os.close(r)
            self.control = w
        self.out = Collector(self.proc.stdout)
        self.err = Collector(self.proc.stderr)

    def write(self, data):
        self.proc.stdin.write(data)
        self.proc.stdin.flush()

    def resize(self, raw):
        os.write(self.control, raw)

    def close_stdin(self):
        self.proc.stdin.close()

    def wait(self, timeout=10.0):
        code = self.proc.wait(timeout)
        self.out.join(2)
        self.err.join(2)
        return code

    def events(self):
        out = []
        for line in self.err.snapshot().decode().splitlines():
            if line.startswith("@@pty_bridge "):
                out.append(json.loads(line[len("@@pty_bridge "):]))
        return out

    def cleanup(self):
        if self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait()
        for f in (self.proc.stdin, self.proc.stdout, self.proc.stderr):
            try:
                f.close()
            except (OSError, ValueError):
                pass
        if self.control is not None:
            os.close(self.control)
            self.control = None


def program(source):
    return [PY, "-c", textwrap.dedent(source)]


class PtyBridgeTestCase(unittest.TestCase):
    def setUp(self):
        self.bridges = []
        self.pids = []
        self.tmp = tempfile.mkdtemp()

    def tearDown(self):
        for b in self.bridges:
            b.cleanup()
        for pid in self.pids:
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass
        shutil.rmtree(self.tmp, ignore_errors=True)

    def bridge(self, command, **kw):
        b = Bridge(command, **kw)
        self.bridges.append(b)
        return b

    def read_pids(self, path, count, timeout=10.0):
        def ready():
            try:
                with open(path) as f:
                    parts = f.read().split()
                return len(parts) >= count
            except OSError:
                return False

        self.assertTrue(wait_until(ready, timeout), "pid file never written")
        with open(path) as f:
            pids = [int(p) for p in f.read().split()]
        self.pids.extend(pids)
        return pids


class RelayTest(PtyBridgeTestCase):
    def test_ansi_and_korean_output_relayed_unchanged(self):
        b = self.bridge(program(r"""
            import os
            os.write(1, b"\x1b[31m" + "안녕 세계 😀".encode() + b"\x1b[0m\n")
        """))
        self.assertEqual(b.wait(), 0)
        expected = b"\x1b[31m" + "안녕 세계 😀".encode() + b"\x1b[0m\r\n"
        self.assertIn(expected, b.out.snapshot())

    def test_raw_mode_output_is_byte_exact(self):
        b = self.bridge(program(r"""
            import os, tty
            tty.setraw(0)
            payload = b"\x1b[38;2;255;0;0m" + "한글".encode() + bytes(range(256)) * 4
            os.write(1, b"<<" + payload + b">>")
        """))
        self.assertEqual(b.wait(), 0)
        payload = b"\x1b[38;2;255;0;0m" + "한글".encode() + bytes(range(256)) * 4
        out = b.out.snapshot()
        self.assertEqual(out[out.index(b"<<") + 2 : out.rindex(b">>")], payload)

    def test_stdin_bytes_reach_the_program_unchanged(self):
        b = self.bridge(program(r"""
            import os, tty
            tty.setraw(0)
            os.write(1, b"READY\r\n")
            data = b""
            while not data.endswith(b"END"):
                data += os.read(0, 1024)
            os.write(1, b"HEX:" + data.hex().encode() + b"\r\n")
        """))
        b.out.wait_for("READY")
        sent = "안녕".encode() + b"\x1b[A\x03\x7f\r\x1b\rEND"
        b.write(sent)
        b.out.wait_for("HEX:")
        self.assertEqual(b.wait(), 0)
        self.assertIn(b"HEX:" + sent.hex().encode(), b.out.snapshot())

    def test_large_paste_while_program_echoes_does_not_deadlock(self):
        size = 1 << 20
        b = self.bridge(program(r"""
            import os, tty
            tty.setraw(0)
            os.write(1, b"READY")
            left = %d
            while left:
                chunk = os.read(0, 65536)
                left -= len(chunk)
                os.write(1, chunk)
        """ % size))
        b.out.wait_for("READY")
        payload = (b"0123456789abcdef" * (size // 16))[:size]
        writer = threading.Thread(target=b.write, args=(payload,), daemon=True)
        writer.start()
        self.assertEqual(b.wait(timeout=30), 0)
        writer.join(5)
        out = b.out.snapshot()
        self.assertEqual(out[out.index(b"READY") + 5 :], payload)

    def test_large_output_arrives_complete_and_in_order(self):
        b = self.bridge(program(r"""
            import os, tty
            tty.setraw(0)
            for i in range(20000):
                os.write(1, b"%08d\n" % i)
        """))
        self.assertEqual(b.wait(timeout=30), 0)
        lines = b.out.snapshot().split(b"\n")
        self.assertEqual([int(x) for x in lines if x.strip()], list(range(20000)))


class ResizeTest(PtyBridgeTestCase):
    SOURCE = r"""
        import fcntl, os, signal, struct, termios, time
        def size():
            rows, cols, _, _ = struct.unpack("HHHH", fcntl.ioctl(1, termios.TIOCGWINSZ, b"\0" * 8))
            return cols, rows
        def on_winch(*_):
            os.write(1, ("WINCH %d %d\n" % size()).encode())
        signal.signal(signal.SIGWINCH, on_winch)
        os.write(1, ("INIT %d %d\n" % size()).encode())
        while True:
            time.sleep(0.05)
    """

    def test_initial_size_and_resize_with_partial_lines(self):
        b = self.bridge(program(self.SOURCE), cols=100, rows=30)
        b.out.wait_for("INIT 100 30")
        b.resize(b"12")
        time.sleep(0.2)
        self.assertNotIn(b"WINCH", b.out.snapshot())
        b.resize(b"0,40\n")
        b.out.wait_for("WINCH 120 40")

    def test_same_size_resize_still_signals(self):
        b = self.bridge(program(self.SOURCE), cols=80, rows=24)
        b.out.wait_for("INIT 80 24")
        b.resize(b"80,24\n")
        b.out.wait_for("WINCH 80 24")

    def test_garbage_ignored_and_batched_lines_coalesce(self):
        b = self.bridge(program(self.SOURCE), cols=100, rows=30)
        b.out.wait_for("INIT 100 30")
        b.resize(b"garbage\n,\n0,0x\n90,25\n91,31\n")
        b.out.wait_for("WINCH 91 31")
        self.assertNotIn(b"WINCH 90 25", b.out.snapshot())

    def test_works_without_control_channel(self):
        b = self.bridge(program('import os; os.write(1, b"OK\\n")'), control=False)
        self.assertEqual(b.wait(), 0)
        self.assertIn(b"OK", b.out.snapshot())


class ExitCodeTest(PtyBridgeTestCase):
    def test_exit_code_passthrough(self):
        b = self.bridge(program("import sys; sys.exit(7)"))
        self.assertEqual(b.wait(), 7)
        started = [e for e in b.events() if e["event"] == "started"]
        self.assertEqual(len(started), 1)
        self.assertIsInstance(started[0]["pid"], int)

    def test_signal_death_maps_to_128_plus_n(self):
        b = self.bridge(program("import os, signal; os.kill(os.getpid(), signal.SIGTERM)"))
        self.assertEqual(b.wait(), 128 + signal.SIGTERM)

    def test_command_not_found_is_127_with_marker(self):
        b = self.bridge(["definitely-not-a-command-ai-terminal"])
        self.assertEqual(b.wait(), 127)
        events = b.events()
        self.assertEqual(len(events), 1, events)
        self.assertEqual(events[0]["event"], "exec_failed")
        self.assertEqual(events[0]["command"], "definitely-not-a-command-ai-terminal")
        self.assertEqual(events[0]["code"], "ENOENT")
        self.assertEqual(events[0]["errno"], errno.ENOENT)
        self.assertEqual(b.out.snapshot(), b"")

    def test_not_executable_is_126_with_marker(self):
        path = os.path.join(self.tmp, "not-executable")
        with open(path, "w") as f:
            f.write("#!/bin/sh\necho hi\n")
        os.chmod(path, 0o644)
        b = self.bridge([path])
        self.assertEqual(b.wait(), 126)
        self.assertEqual(b.events()[0]["code"], "EACCES")

    def test_usage_error(self):
        p = subprocess.run([PY, "-I", HELPER, "80"], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertEqual(p.returncode, 2)
        self.assertIn(b"usage", p.stderr)

    def test_environment_is_left_to_the_caller(self):
        env = dict(os.environ, AIT_PROBE="from-caller", TERM="xterm-256color")
        b = Bridge.__new__(Bridge)
        b.control = None
        b.proc = subprocess.Popen(
            [PY, "-I", HELPER, "80", "24", PY, "-c", 'import os; os.write(1, ("T=%s P=%s" % (os.environ.get("TERM"), os.environ.get("AIT_PROBE"))).encode())'],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
        )
        b.out, b.err = Collector(b.proc.stdout), Collector(b.proc.stderr)
        self.bridges.append(b)
        self.assertEqual(b.wait(), 0)
        self.assertIn(b"T=xterm-256color P=from-caller", b.out.snapshot())

    def test_sigpipe_restored_for_program(self):
        # Python ignores SIGPIPE; if that leaked into the program, `yes` would report "Broken pipe".
        b = self.bridge(["/bin/sh", "-c", "yes | head -n 1; echo STATUS=$?"])
        self.assertEqual(b.wait(), 0)
        out = b.out.snapshot()
        self.assertIn(b"STATUS=0", out)
        self.assertNotIn(b"Broken pipe", out)

    def test_resize_channel_not_leaked_to_program(self):
        b = self.bridge(program('import os; os.write(1, b"FD3=%d" % int(os.path.exists("/dev/fd/3")))'))
        self.assertEqual(b.wait(), 0)
        self.assertIn(b"FD3=0", b.out.snapshot())


HUP_IGNORING_FAMILY = r"""
import os, signal, subprocess, sys, time
signal.signal(signal.SIGHUP, signal.SIG_IGN)
sleeper = [sys.executable, "-c", "import signal, time; signal.signal(signal.SIGHUP, signal.SIG_IGN); time.sleep(600)"]
same_group = subprocess.Popen(sleeper)
own_group = subprocess.Popen(sleeper, preexec_fn=lambda: os.setpgid(0, 0))
own_session = subprocess.Popen(sleeper, start_new_session=True)
with open(sys.argv[1], "w") as f:
    f.write("%d %d %d %d\n" % (os.getpid(), same_group.pid, own_group.pid, own_session.pid))
os.write(1, b"READY\n")
time.sleep(600)
"""


class ShutdownTest(PtyBridgeTestCase):
    def test_stdin_eof_sends_sighup_first(self):
        b = self.bridge(program(r"""
            import os, time
            os.write(1, b"READY\n")
            time.sleep(600)
        """))
        b.out.wait_for("READY")
        start = time.monotonic()
        b.close_stdin()
        self.assertEqual(b.wait(), 128 + signal.SIGHUP)
        self.assertLess(time.monotonic() - start, 2.0)

    def test_sigterm_to_helper_stops_program(self):
        b = self.bridge(program(r"""
            import os, time
            os.write(1, b"READY\n")
            time.sleep(600)
        """))
        b.out.wait_for("READY")
        b.proc.send_signal(signal.SIGTERM)
        self.assertEqual(b.wait(), 128 + signal.SIGHUP)

    def test_stdin_eof_with_sighup_ignoring_family_sigkills_after_grace(self):
        pidfile = os.path.join(self.tmp, "pids")
        b = self.bridge([PY, "-c", HUP_IGNORING_FAMILY, pidfile])
        b.out.wait_for("READY")
        pids = self.read_pids(pidfile, 4)
        start = time.monotonic()
        b.close_stdin()
        code = b.wait(timeout=10)
        elapsed = time.monotonic() - start
        self.assertEqual(code, 128 + signal.SIGKILL)
        self.assertGreaterEqual(elapsed, 2.8)
        self.assertLess(elapsed, 5.0)
        for pid in pids:
            self.assertTrue(wait_until(lambda: not alive(pid), 2.0), "pid %d survived" % pid)

    def test_leftovers_are_cleaned_after_natural_exit(self):
        pidfile = os.path.join(self.tmp, "pids")
        b = self.bridge(program(r"""
            import os, subprocess, sys, time
            pidfile = sys.argv[1]
            # Own process group, so the kernel's hangup on session-leader exit (foreground group only) misses it.
            sleeper = "import os, sys, time; open(sys.argv[1], 'w').write('%d' % os.getpid()); time.sleep(600)"
            subprocess.Popen([sys.executable, "-c", sleeper, pidfile], preexec_fn=lambda: os.setpgid(0, 0))
            while not (os.path.exists(pidfile) and open(pidfile).read()):
                time.sleep(0.02)
            time.sleep(0.2)
            sys.exit(5)
        """) + [pidfile])
        self.assertEqual(b.wait(), 5)
        (gc,) = self.read_pids(pidfile, 1)
        self.assertTrue(wait_until(lambda: not alive(gc), 2.0), "grandchild %d survived" % gc)


INTERMEDIATE = r"""
import os, subprocess, sys, time
helper_stdin = None if sys.argv[1] == "inherit" else subprocess.PIPE
p = subprocess.Popen([sys.executable, "-I"] + sys.argv[3:], stdin=helper_stdin,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
with open(sys.argv[2], "w") as f:
    f.write("%d\n" % p.pid)
time.sleep(600)
"""


class ParentDeathTest(PtyBridgeTestCase):
    def run_parent_death(self, stdin_mode):
        helper_pidfile = os.path.join(self.tmp, "helper")
        family_pidfile = os.path.join(self.tmp, "family")
        stdin_r, stdin_w = os.pipe()
        try:
            middle = subprocess.Popen(
                [PY, "-c", INTERMEDIATE, stdin_mode, helper_pidfile, HELPER, "80", "24", PY, "-c", HUP_IGNORING_FAMILY, family_pidfile],
                stdin=stdin_r,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            os.close(stdin_r)
            stdin_r = None
            self.pids.append(middle.pid)
            (helper,) = self.read_pids(helper_pidfile, 1)
            family = self.read_pids(family_pidfile, 4)
            time.sleep(0.3)
            start = time.monotonic()
            middle.kill()
            middle.wait()
            everything = [helper] + family
            gone = wait_until(lambda: not any(alive(p) for p in everything), 5.0)
            survivors = [p for p in everything if alive(p)]
            self.assertTrue(gone, "still alive after %.1fs: %s" % (time.monotonic() - start, survivors))
            self.assertLess(time.monotonic() - start, 5.0)
        finally:
            if stdin_r is not None:
                os.close(stdin_r)
            os.close(stdin_w)

    def test_parent_death_detected_by_ppid_poll(self):
        # stdin stays open (held by this test), so only the getppid() watch can notice.
        self.run_parent_death("inherit")

    def test_parent_crash_closes_stdin(self):
        self.run_parent_death("pipe")


if __name__ == "__main__":
    unittest.main()
