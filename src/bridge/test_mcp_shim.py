"""Tests for mcp_shim.py (run from this directory: python3 -m unittest test_mcp_shim)."""

import json
import os
import socket
import socketserver
import subprocess
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
SHIM = os.path.join(HERE, "mcp_shim.py")
TOKEN = "tok-6c1f0d2e-secret-bridge-token"


def base_env():
    env = {k: v for k, v in os.environ.items() if not k.startswith("OBSIDIAN_")}
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    return env


class Shim:
    """The shim as a subprocess, talking newline-delimited JSON-RPC."""

    def __init__(self, extra_env=None):
        env = base_env()
        env.update(extra_env or {})
        self.proc = subprocess.Popen(
            [sys.executable, SHIM], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
            cwd=HERE,
        )
        self.lines = []
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()

    def _read(self):
        for line in self.proc.stdout:
            self.lines.append(line)

    def send(self, obj):
        data = obj if isinstance(obj, bytes) else json.dumps(obj).encode("utf-8")
        self.proc.stdin.write(data + b"\n")
        self.proc.stdin.flush()

    def wait_lines(self, n, timeout=10.0):
        deadline = time.time() + timeout
        while len(self.lines) < n and time.time() < deadline:
            time.sleep(0.01)
        if len(self.lines) < n:
            raise AssertionError("expected %d lines, got %d: %r" % (n, len(self.lines), self.lines))
        return [json.loads(line) for line in self.lines[:n]]

    def request(self, obj, timeout=10.0):
        before = len(self.lines)
        self.send(obj)
        return self.wait_lines(before + 1, timeout)[before]

    def close(self, timeout=5.0):
        """Closes stdin (EOF) and returns (exit code, stderr bytes, all stdout bytes)."""
        self.proc.stdin.close()
        code = self.proc.wait(timeout)
        self.reader.join(timeout)
        err = self.proc.stderr.read()
        self.proc.stderr.close()
        self.proc.stdout.close()
        return code, err, b"".join(self.lines)


class Bridge(HTTPServer):
    """A stand-in for the plugin's Streamable HTTP endpoint."""

    def __init__(self):
        HTTPServer.__init__(self, ("127.0.0.1", 0), Handler)
        self.received = []  # (path, headers dict, body)
        self.thread = threading.Thread(target=self.serve_forever, daemon=True)
        self.thread.start()

    def server_bind(self):
        # HTTPServer.server_bind does a reverse DNS lookup (getfqdn), which can take ~30 s on macOS.
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]

    @property
    def url(self):
        return "http://127.0.0.1:%d" % self.server_address[1]

    def stop(self):
        self.shutdown()
        self.server_close()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send_body(self, status, body, content_type="application/json", headers=None):
        data = body if isinstance(body, bytes) else json.dumps(body, indent=2).encode("utf-8")
        self.send_response(status)
        if data:
            self.send_header("Content-Type", content_type)
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        self.server.received.append((self.path, dict(self.headers.items()), body))
        if self.headers.get("Authorization") != "Bearer " + TOKEN:
            self.send_body(401, {"error": "unauthorized"})
            return
        if self.path != "/mcp":
            self.send_body(404, {"error": "not_found"})
            return
        accept = self.headers.get("Accept", "")
        if "application/json" not in accept or "text/event-stream" not in accept:
            self.send_body(406, {"jsonrpc": "2.0", "id": None, "error": {"code": -32000, "message": "Not Acceptable"}})
            return
        msg = json.loads(body.decode("utf-8"))
        if "id" not in msg:
            self.send_body(202, b"")
            return
        method = msg.get("method")
        if method == "initialize":
            self.send_body(200, {"jsonrpc": "2.0", "id": msg["id"], "result": {
                "protocolVersion": "2025-06-18", "capabilities": {"tools": {}},
                "serverInfo": {"name": "obsidian-bridge", "version": "1"}}}, headers={"Mcp-Session-Id": "sess-1"})
        elif method == "tools/list":
            self.send_body(200, {"jsonrpc": "2.0", "id": msg["id"], "result": {"tools": [{"name": "get_active_note"}]}})
        elif method == "tools/call":
            text = json.dumps({"path": "Notes/X.md", "content": "한글 note"}, ensure_ascii=False)
            self.send_body(200, {"jsonrpc": "2.0", "id": msg["id"], "result": {"content": [{"type": "text", "text": text}]}},
                           content_type="application/json; charset=utf-8")
        elif method == "sse/test":
            events = [
                ": comment line\n\n",
                "event: message\ndata: " + json.dumps({"jsonrpc": "2.0", "method": "notifications/progress", "params": {"progress": 1}}) + "\n\n",
                "id: 7\r\ndata: {\"jsonrpc\": \"2.0\",\r\ndata:  \"id\": " + json.dumps(msg["id"]) + ", \"result\": {\"ok\": true}}\r\n\r\n",
            ]
            self.send_body(200, "".join(events).encode("utf-8"), content_type="text/event-stream")
        elif method == "fail/500":
            self.send_body(500, b"boom", content_type="text/plain")
        elif method == "fail/rpc":
            self.send_body(400, {"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32602, "message": "Invalid params"}})
        elif method == "fail/empty":
            self.send_body(202, b"")
        elif method == "fail/refused":
            # How the plugin refuses /mcp with the bridge tools off (JSON-RPC error body, id null).
            self.send_body(403, {"jsonrpc": "2.0", "id": None, "error": {
                "code": -32000, "message": "Obsidian bridge tools are turned off in the AI Terminal settings."}})
        elif method == "fail/plain":
            self.send_body(404, {"error": "not_found", "message": "No route\nfor POST /x"})
        else:
            self.send_body(200, {"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32601, "message": "Method not found"}})


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class OfflineTests(unittest.TestCase):
    """No OBSIDIAN_BRIDGE_* variables: agy started outside Obsidian (R11.7)."""

    def setUp(self):
        self.shim = Shim()

    def tearDown(self):
        if self.shim.proc.poll() is None:
            self.shim.proc.kill()
            self.shim.proc.wait()

    def test_initialize_list_call(self):
        init = self.shim.request({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "antigravity-client", "version": "1"}}})
        self.assertEqual(init["id"], 1)
        self.assertEqual(init["result"]["serverInfo"]["name"], "obsidian")
        self.assertEqual(init["result"]["protocolVersion"], "2025-11-25")
        self.assertIn("tools", init["result"]["capabilities"])
        self.shim.send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        listed = self.shim.request({"jsonrpc": "2.0", "id": "two", "method": "tools/list", "params": {}})
        self.assertEqual(listed, {"jsonrpc": "2.0", "id": "two", "result": {"tools": []}})
        called = self.shim.request({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "get_active_note"}})
        self.assertTrue(called["result"]["isError"])
        self.assertEqual(called["result"]["content"][0]["text"], "Obsidian bridge not available — start agy from Obsidian")
        self.assertEqual(self.shim.request({"jsonrpc": "2.0", "id": 4, "method": "ping"})["result"], {})
        code, err, out = self.shim.close()
        self.assertEqual(code, 0)
        self.assertEqual(err, b"")
        self.assertEqual(len(out.splitlines()), 4)  # the notification got no answer

    def test_unknown_methods_and_garbage(self):
        discover = self.shim.request({"jsonrpc": "2.0", "id": 1, "method": "server/discover", "params": {}})
        self.assertEqual(discover["error"]["code"], -32601)
        self.assertEqual(discover["id"], 1)
        bad = self.shim.request(b"{not json")
        self.assertEqual(bad["error"]["code"], -32700)
        self.assertIsNone(bad["id"])
        self.shim.send(b"")
        self.shim.send({"jsonrpc": "2.0", "id": 9, "result": {}})  # a response to nothing: ignored
        batch = self.shim.request([{"jsonrpc": "2.0", "id": 5, "method": "tools/list"},
                                   {"jsonrpc": "2.0", "method": "notifications/initialized"}])
        self.assertEqual(batch, [{"jsonrpc": "2.0", "id": 5, "result": {"tools": []}}])
        code, err, _ = self.shim.close()
        self.assertEqual((code, err), (0, b""))

    def test_eof_exits_promptly(self):
        start = time.time()
        code, err, out = self.shim.close()
        self.assertEqual((code, err, out), (0, b"", b""))
        self.assertLess(time.time() - start, 3)

    def test_only_one_variable_is_offline(self):
        self.shim.close()
        for extra in ({"OBSIDIAN_BRIDGE_URL": "http://127.0.0.1:9"}, {"OBSIDIAN_BRIDGE_TOKEN": TOKEN},
                      {"OBSIDIAN_BRIDGE_URL": "ftp://x", "OBSIDIAN_BRIDGE_TOKEN": TOKEN}):
            shim = Shim(extra)
            listed = shim.request({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
            self.assertEqual(listed["result"], {"tools": []})
            code, err, out = shim.close()
            self.assertEqual((code, err), (0, b""))
            self.assertNotIn(TOKEN.encode(), out)
        self.shim = shim


class ForwardingTests(unittest.TestCase):
    """OBSIDIAN_BRIDGE_URL + OBSIDIAN_BRIDGE_TOKEN set: agy started by the plugin (R11.6)."""

    def setUp(self):
        self.bridge = Bridge()
        self.shim = Shim({"OBSIDIAN_BRIDGE_URL": self.bridge.url, "OBSIDIAN_BRIDGE_TOKEN": TOKEN})

    def tearDown(self):
        if self.shim.proc.poll() is None:
            self.shim.proc.kill()
            self.shim.proc.wait()
        self.bridge.stop()

    def finish(self):
        code, err, out = self.shim.close()
        self.assertEqual(code, 0)
        self.assertEqual(err, b"")
        self.assertNotIn(TOKEN.encode(), out)
        return out

    def test_forwards_with_headers_and_preserves_ids(self):
        init = self.shim.request({"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {"protocolVersion": "2025-11-25"}})
        self.assertEqual(init["id"], 0)
        self.assertEqual(init["result"]["serverInfo"]["name"], "obsidian-bridge")
        self.shim.send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        listed = self.shim.request({"jsonrpc": "2.0", "id": "req-é", "method": "tools/list"})
        self.assertEqual(listed["id"], "req-é")
        self.assertEqual(listed["result"]["tools"], [{"name": "get_active_note"}])
        called = self.shim.request({"jsonrpc": "2.0", "id": 12345678901234, "method": "tools/call",
                                    "params": {"name": "get_active_note", "arguments": {}}})
        self.assertEqual(called["id"], 12345678901234)
        self.assertEqual(json.loads(called["result"]["content"][0]["text"])["content"], "한글 note")
        out = self.finish()
        self.assertEqual(len(out.splitlines()), 3)  # one line per answer; the 202 notification wrote nothing
        received = self.bridge.received
        self.assertEqual([json.loads(b.decode())["method"] for _, _, b in received],
                         ["initialize", "notifications/initialized", "tools/list", "tools/call"])
        for path, headers, _ in received:
            self.assertEqual(path, "/mcp")
            self.assertEqual(headers["Authorization"], "Bearer " + TOKEN)
            self.assertEqual(headers["Content-Type"], "application/json")
            self.assertEqual(headers["Accept"], "application/json, text/event-stream")
        # after initialize: negotiated protocol version and the session id go along
        self.assertNotIn("MCP-Protocol-Version", received[0][1])
        self.assertEqual(received[2][1]["MCP-Protocol-Version"], "2025-06-18")
        self.assertEqual(received[2][1]["Mcp-Session-Id"], "sess-1")
        # the body is forwarded byte for byte
        self.assertEqual(json.loads(received[3][2].decode()), {"jsonrpc": "2.0", "id": 12345678901234, "method": "tools/call",
                                                               "params": {"name": "get_active_note", "arguments": {}}})

    def test_sse_body(self):
        self.shim.send({"jsonrpc": "2.0", "id": "s1", "method": "sse/test"})
        progress, answer = self.shim.wait_lines(2)
        self.assertEqual(progress["method"], "notifications/progress")
        self.assertEqual(answer, {"jsonrpc": "2.0", "id": "s1", "result": {"ok": True}})
        self.finish()

    def test_http_errors_become_jsonrpc_errors(self):
        e500 = self.shim.request({"jsonrpc": "2.0", "id": 1, "method": "fail/500"})
        self.assertEqual(e500["id"], 1)
        self.assertEqual(e500["error"]["code"], -32000)
        self.assertIn("HTTP 500", e500["error"]["message"])
        rpc = self.shim.request({"jsonrpc": "2.0", "id": 2, "method": "fail/rpc"})
        self.assertEqual(rpc, {"jsonrpc": "2.0", "id": 2, "error": {"code": -32602, "message": "Invalid params"}})
        empty = self.shim.request({"jsonrpc": "2.0", "id": 3, "method": "fail/empty"})
        self.assertEqual(empty["id"], 3)
        self.assertIn("no answer", empty["error"]["message"])
        self.finish()

    def test_refusal_message_reaches_agy(self):
        refused = self.shim.request({"jsonrpc": "2.0", "id": 1, "method": "fail/refused"})
        self.assertEqual(refused["id"], 1)
        self.assertEqual(refused["error"]["code"], -32000)
        self.assertEqual(refused["error"]["message"],
                         "Obsidian bridge error (HTTP 403): Obsidian bridge tools are turned off in the AI Terminal settings.")
        plain = self.shim.request({"jsonrpc": "2.0", "id": 2, "method": "fail/plain"})
        self.assertEqual(plain["error"]["message"], "Obsidian bridge error (HTTP 404): No route for POST /x")
        self.finish()

    def test_wrong_token_is_401_error_without_token(self):
        self.shim.close()
        self.shim = Shim({"OBSIDIAN_BRIDGE_URL": self.bridge.url + "/", "OBSIDIAN_BRIDGE_TOKEN": "wrong-token-123456"})
        answer = self.shim.request({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        self.assertEqual(answer["id"], 1)
        self.assertIn("HTTP 401", answer["error"]["message"])
        self.assertEqual(self.bridge.received[-1][0], "/mcp")  # trailing slash in the URL handled
        code, err, out = self.shim.close()
        self.assertEqual((code, err), (0, b""))
        self.assertNotIn(b"wrong-token-123456", out)

    def test_network_error(self):
        self.shim.close()
        self.shim = Shim({"OBSIDIAN_BRIDGE_URL": "http://127.0.0.1:%d" % free_port(), "OBSIDIAN_BRIDGE_TOKEN": TOKEN})
        answer = self.shim.request({"jsonrpc": "2.0", "id": "n1", "method": "tools/call", "params": {"name": "get_selection"}})
        self.assertEqual(answer["id"], "n1")
        self.assertEqual(answer["error"]["code"], -32000)
        self.assertIn("not reachable", answer["error"]["message"])
        self.shim.send({"jsonrpc": "2.0", "method": "notifications/initialized"})  # no answer, no crash
        again = self.shim.request({"jsonrpc": "2.0", "id": 2, "method": "ping"})
        self.assertEqual(again["id"], 2)
        out = self.finish()
        self.assertEqual(len(out.splitlines()), 2)

    def test_parse_error_is_answered_locally(self):
        bad = self.shim.request(b"not json at all")
        self.assertEqual(bad["error"]["code"], -32700)
        self.finish()
        self.assertEqual(self.bridge.received, [])

    def test_eof_exits(self):
        start = time.time()
        out = self.finish()
        self.assertEqual(out, b"")
        self.assertLess(time.time() - start, 3)


class ServeUnitTests(unittest.TestCase):
    """`serve()` in-process (no subprocess): end of input returns."""

    def test_serve_returns_on_eof(self):
        import io
        sys.path.insert(0, HERE)
        try:
            import mcp_shim
        finally:
            sys.path.remove(HERE)
        out = io.BytesIO()
        mcp_shim.serve(io.BytesIO(b'{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n'), out, {})
        self.assertEqual(json.loads(out.getvalue().decode()), {"jsonrpc": "2.0", "id": 1, "result": {"tools": []}})


if __name__ == "__main__":
    unittest.main()
