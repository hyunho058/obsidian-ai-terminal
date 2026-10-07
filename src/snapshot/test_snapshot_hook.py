"""Tests for snapshot_hook.py (run from this directory: python3 -m unittest test_snapshot_hook)."""

import http.server
import io
import json
import os
import socketserver
import subprocess
import sys
import threading
import time
import unittest

import snapshot_hook

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "snapshot_hook.py")
TOKEN = "test-token-0123456789"


class Recorder(http.server.BaseHTTPRequestHandler):
    requests = []
    delay = 0.0
    status = 200

    def do_POST(self):  # noqa: N802 (http.server API)
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length)
        type(self).requests.append({"path": self.path, "headers": dict(self.headers), "body": body})
        if type(self).delay:
            time.sleep(type(self).delay)
        data = json.dumps({"status": "committed"}).encode()
        try:
            self.send_response(type(self).status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except OSError:
            pass

    def log_message(self, *args):
        pass


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def server_bind(self):
        # HTTPServer.server_bind calls socket.getfqdn(), which can take ~35 s without reverse DNS.
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]


class HookTest(unittest.TestCase):
    def setUp(self):
        Recorder.requests = []
        Recorder.delay = 0.0
        Recorder.status = 200
        self.server = Server(("127.0.0.1", 0), Recorder)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = "http://127.0.0.1:%d" % self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def env(self, **extra):
        env = {k: v for k, v in os.environ.items() if not k.startswith("OBSIDIAN_")}
        env.update({"OBSIDIAN_BRIDGE_URL": self.url, "OBSIDIAN_BRIDGE_TOKEN": TOKEN, "OBSIDIAN_PANEL_ID": "panel-1"})
        # A proxy in the environment must not be used for 127.0.0.1.
        env.update({"HTTP_PROXY": "http://127.0.0.1:9", "http_proxy": "http://127.0.0.1:9"})
        env.update(extra)
        return env

    def run_hook(self, env, stdin_text, timeout=20):
        return subprocess.run(
            [sys.executable, "-I", HOOK],
            input=stdin_text.encode("utf-8"),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
        )

    def hook_input(self, prompt):
        return json.dumps(
            {
                "session_id": "s1",
                "transcript_path": "/tmp/t.jsonl",
                "cwd": "/vault",
                "hook_event_name": "UserPromptSubmit",
                "prompt": prompt,
            }
        )

    def test_posts_prompt_excerpt_with_token_and_prints_nothing(self):
        prompt = "make this shorter " + "한글" * 200
        r = self.run_hook(self.env(), self.hook_input(prompt))
        self.assertEqual(r.returncode, 0)
        self.assertEqual(r.stdout, b"")
        self.assertEqual(r.stderr, b"")
        self.assertEqual(len(Recorder.requests), 1)
        req = Recorder.requests[0]
        self.assertEqual(req["path"], "/snapshot")
        self.assertEqual(req["headers"].get("Authorization"), "Bearer " + TOKEN)
        self.assertEqual(req["headers"].get("Content-Type"), "application/json")
        body = json.loads(req["body"].decode("utf-8"))
        self.assertEqual(body, {"panelId": "panel-1", "prompt": prompt[:200], "ai": "claude"})

    def test_bridge_token_in_the_prompt_is_redacted_before_the_cut(self):
        # The token straddles the 200-character limit: cutting first would send a recognisable token prefix.
        prompt = "x" * 190 + TOKEN + " tail"
        r = self.run_hook(self.env(), self.hook_input(prompt))
        self.assertEqual((r.returncode, r.stdout, r.stderr), (0, b"", b""))
        sent = json.loads(Recorder.requests[0]["body"].decode("utf-8"))["prompt"]
        self.assertEqual(sent, ("x" * 190 + "[REDACTED] tail")[:200])
        self.assertNotIn(TOKEN[:8], sent)

    def test_missing_env_exits_immediately_without_request(self):
        for missing in ("OBSIDIAN_BRIDGE_URL", "OBSIDIAN_BRIDGE_TOKEN"):
            env = self.env()
            del env[missing]
            r = self.run_hook(env, self.hook_input("hello"))
            self.assertEqual((r.returncode, r.stdout, r.stderr), (0, b"", b""))
        self.assertEqual(Recorder.requests, [])

    def test_server_errors_and_bad_input_still_exit_0_silently(self):
        Recorder.status = 401
        for stdin_text in ("not json", "", json.dumps(["x"]), json.dumps({"prompt": 5})):
            r = self.run_hook(self.env(), stdin_text)
            self.assertEqual((r.returncode, r.stdout, r.stderr), (0, b"", b""))
        self.assertEqual([json.loads(q["body"])["prompt"] for q in Recorder.requests], ["", "", "", ""])

    def test_unreachable_bridge_exits_0_silently(self):
        r = self.run_hook(self.env(OBSIDIAN_BRIDGE_URL="http://127.0.0.1:9"), self.hook_input("x"))
        self.assertEqual((r.returncode, r.stdout, r.stderr), (0, b"", b""))

    def test_gives_up_after_the_timeout(self):
        Recorder.delay = 3.0
        saved = snapshot_hook.TIMEOUT_S
        snapshot_hook.TIMEOUT_S = 0.5
        try:
            env = self.env()
            started = time.monotonic()
            with self.assertRaises(Exception):
                snapshot_hook.main(env=env, stdin=io.BytesIO(self.hook_input("slow").encode()))
            self.assertLess(time.monotonic() - started, 2.5)
        finally:
            snapshot_hook.TIMEOUT_S = saved
        self.assertEqual(len(Recorder.requests), 1)

    def test_default_timeout_is_10_seconds(self):
        self.assertEqual(snapshot_hook.TIMEOUT_S, 10.0)


if __name__ == "__main__":
    unittest.main()
