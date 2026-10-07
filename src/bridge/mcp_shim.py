#!/usr/bin/env python3
"""Obsidian MCP shim for the Antigravity CLI (standard library only, Python >= 3.9).

Registered once, globally, as the stdio MCP server `obsidian` (`agy mcp add obsidian -- <python3> <this file>`).
agy starts it with agy's own environment (verified with agy 1.3.0), so:

  * agy started by the Obsidian plugin has OBSIDIAN_BRIDGE_URL (http://127.0.0.1:<port>, no trailing slash) and
    OBSIDIAN_BRIDGE_TOKEN; every newline-delimited JSON-RPC message from stdin is POSTed to <URL>/mcp with the bearer
    token (Streamable HTTP, stateless) and every JSON-RPC message of the answer is written to stdout, one per line.
    HTTP / network failures become JSON-RPC errors for requests.
  * agy started anywhere else has neither variable: the shim answers `initialize` itself, lists no tools, and
    answers `tools/call` with a tool error. Nothing is ever written to stderr.

The token never leaves this process except in the Authorization header of requests to the bridge.
"""

import http.client
import json
import os
import sys
from urllib.parse import urlsplit

URL_ENV = "OBSIDIAN_BRIDGE_URL"
TOKEN_ENV = "OBSIDIAN_BRIDGE_TOKEN"
SERVER_NAME = "obsidian"
SERVER_VERSION = "1.0.0"
DEFAULT_PROTOCOL_VERSION = "2025-06-18"
UNAVAILABLE_TEXT = "Obsidian bridge not available — start agy from Obsidian"
REQUEST_TIMEOUT_SECONDS = 30.0
MAX_RESPONSE_BYTES = 64 * 1024 * 1024

PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
BRIDGE_ERROR = -32000


class Output:
    """Writes one JSON-RPC message per line to stdout (UTF-8)."""

    def __init__(self, stream):
        self.stream = stream

    def message(self, obj):
        self.raw(json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))

    def raw(self, data):
        self.stream.write(data + b"\n")
        self.stream.flush()


def error_response(msg_id, code, message):
    return {"jsonrpc": "2.0", "id": msg_id, "error": {"code": code, "message": message}}


def result_response(msg_id, result):
    return {"jsonrpc": "2.0", "id": msg_id, "result": result}


def is_request(msg):
    return isinstance(msg, dict) and isinstance(msg.get("method"), str) and "id" in msg and msg["id"] is not None


# --- without the bridge (agy started outside Obsidian) -------------------------------------------------------------


def offline_answer(msg):
    """The answer to one message when no bridge is configured, or None (notifications, responses)."""
    if not isinstance(msg, dict):
        return error_response(None, INVALID_REQUEST, "Invalid Request")
    if not is_request(msg):
        return None
    method = msg["method"]
    msg_id = msg["id"]
    if method == "initialize":
        params = msg.get("params") if isinstance(msg.get("params"), dict) else {}
        requested = params.get("protocolVersion")
        version = requested if isinstance(requested, str) and requested else DEFAULT_PROTOCOL_VERSION
        return result_response(msg_id, {
            "protocolVersion": version,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
        })
    if method == "ping":
        return result_response(msg_id, {})
    if method == "tools/list":
        return result_response(msg_id, {"tools": []})
    if method == "tools/call":
        return result_response(msg_id, {"content": [{"type": "text", "text": UNAVAILABLE_TEXT}], "isError": True})
    if method == "resources/list":
        return result_response(msg_id, {"resources": []})
    if method == "resources/templates/list":
        return result_response(msg_id, {"resourceTemplates": []})
    if method == "prompts/list":
        return result_response(msg_id, {"prompts": []})
    return error_response(msg_id, METHOD_NOT_FOUND, "Method not found: %s" % method)


def handle_offline(msg, out):
    if isinstance(msg, list):
        answers = [a for a in (offline_answer(m) for m in msg) if a is not None]
        if answers:
            out.message(answers)
        return
    answer = offline_answer(msg)
    if answer is not None:
        out.message(answer)


# --- with the bridge ------------------------------------------------------------------------------------------------


class BridgeError(Exception):
    pass


class Bridge:
    """POSTs JSON-RPC messages to the plugin's Streamable HTTP endpoint (stateless; one connection per message)."""

    def __init__(self, base_url, token, timeout=REQUEST_TIMEOUT_SECONDS):
        parts = urlsplit(base_url.strip())
        if parts.scheme not in ("http", "https") or not parts.hostname:
            raise ValueError("unsupported bridge URL")
        self.scheme = parts.scheme
        self.host = parts.hostname
        self.port = parts.port
        path = parts.path.rstrip("/")
        self.path = path if path.endswith("/mcp") else path + "/mcp"
        self.token = token
        self.timeout = timeout
        self.session_id = None
        self.protocol_version = None

    def headers(self):
        h = {
            "Authorization": "Bearer " + self.token,
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }
        if self.session_id:
            h["Mcp-Session-Id"] = self.session_id
        if self.protocol_version:
            h["MCP-Protocol-Version"] = self.protocol_version
        return h

    def post(self, body, emit):
        """Sends `body` (bytes) and calls `emit(message)` for each JSON-RPC message of the answer.

        Returns the number of messages emitted. Raises BridgeError (text safe to show; never contains the token)."""
        conn_class = http.client.HTTPSConnection if self.scheme == "https" else http.client.HTTPConnection
        conn = conn_class(self.host, self.port, timeout=self.timeout)
        try:
            try:
                conn.request("POST", self.path, body=body, headers=self.headers())
                resp = conn.getresponse()
            except (OSError, http.client.HTTPException) as err:
                raise BridgeError("Obsidian bridge not reachable (%s) — is Obsidian still running?" % describe(err))
            session = resp.getheader("Mcp-Session-Id")
            if session:
                self.session_id = session
            content_type = (resp.getheader("Content-Type") or "").split(";", 1)[0].strip().lower()
            try:
                if resp.status >= 400:
                    return self.http_error(resp, emit)
                if content_type == "text/event-stream":
                    return read_sse(resp, emit)
                data = resp.read(MAX_RESPONSE_BYTES + 1)
            except (OSError, http.client.HTTPException) as err:
                raise BridgeError("Obsidian bridge connection failed (%s)" % describe(err))
            if len(data) > MAX_RESPONSE_BYTES:
                raise BridgeError("Obsidian bridge answer too large")
            if not data.strip():
                return 0
            try:
                emit(json.loads(data.decode("utf-8")))
            except ValueError:
                raise BridgeError("Obsidian bridge sent an invalid answer (HTTP %d)" % resp.status)
            return 1
        finally:
            conn.close()

    def http_error(self, resp, emit):
        status = resp.status
        try:
            data = resp.read(MAX_RESPONSE_BYTES)
            payload = json.loads(data.decode("utf-8")) if data.strip() else None
        except (OSError, ValueError, http.client.HTTPException):
            payload = None
        rpc_error = isinstance(payload, dict) and payload.get("jsonrpc") == "2.0" and isinstance(payload.get("error"), dict)
        # A JSON-RPC error answer for this message from the MCP server itself is passed through unchanged.
        if rpc_error and payload.get("id") is not None:
            emit(payload)
            return 1
        if status == 401:
            raise BridgeError("Obsidian bridge rejected the request (HTTP 401) — the plugin was reloaded; restart agy from Obsidian")
        detail = payload["error"].get("message") if rpc_error else None
        if isinstance(detail, str) and detail:
            raise BridgeError("Obsidian bridge error (HTTP %d): %s" % (status, detail[:300]))
        raise BridgeError("Obsidian bridge error (HTTP %d)" % status)


def read_sse(resp, emit):
    """Emits the JSON `data` of each Server-Sent Event as it arrives."""
    count = 0
    data_lines = []
    total = 0
    while True:
        line = resp.readline(MAX_RESPONSE_BYTES)
        total += len(line)
        if total > MAX_RESPONSE_BYTES:
            raise BridgeError("Obsidian bridge answer too large")
        end = not line
        text = line.decode("utf-8", "replace").rstrip("\r\n")
        if end or text == "":
            if data_lines:
                payload = "\n".join(data_lines)
                data_lines = []
                try:
                    emit(json.loads(payload))
                    count += 1
                except ValueError:
                    pass
            if end:
                return count
            continue
        if text.startswith(":"):
            continue
        field, _, value = text.partition(":")
        if value.startswith(" "):
            value = value[1:]
        if field == "data":
            data_lines.append(value)


def describe(err):
    if isinstance(err, OSError) and err.strerror:
        return err.strerror
    name = type(err).__name__
    return "timed out" if "timeout" in name.lower() else name


def request_ids(msg):
    """Ids of the requests in a message (or batch) that expect an answer."""
    items = msg if isinstance(msg, list) else [msg]
    return [m["id"] for m in items if is_request(m)]


def handle_online(bridge, raw_line, msg, out):
    ids = request_ids(msg)
    answered = set()
    is_initialize = isinstance(msg, dict) and msg.get("method") == "initialize"

    def emit(obj):
        items = obj if isinstance(obj, list) else [obj]
        for item in items:
            if isinstance(item, dict) and "id" in item and ("result" in item or "error" in item):
                answered.add(json.dumps(item["id"]))
                if is_initialize and isinstance(item.get("result"), dict):
                    version = item["result"].get("protocolVersion")
                    if isinstance(version, str) and version:
                        bridge.protocol_version = version
        out.message(obj)

    try:
        bridge.post(raw_line, emit)
    except BridgeError as err:
        for msg_id in ids:
            if json.dumps(msg_id) not in answered:
                out.message(error_response(msg_id, BRIDGE_ERROR, str(err)))
        return
    for msg_id in ids:
        if json.dumps(msg_id) not in answered:
            out.message(error_response(msg_id, BRIDGE_ERROR, "Obsidian bridge sent no answer"))


# --- main loop ------------------------------------------------------------------------------------------------------


def make_bridge(environ):
    url = environ.get(URL_ENV, "").strip()
    token = environ.get(TOKEN_ENV, "").strip()
    if not url or not token:
        return None
    try:
        return Bridge(url, token)
    except ValueError:
        return None


def serve(stdin, stdout, environ):
    out = Output(stdout)
    bridge = make_bridge(environ)
    while True:
        line = stdin.readline()
        if not line:
            return
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line.decode("utf-8"))
        except ValueError:
            out.message(error_response(None, PARSE_ERROR, "Parse error"))
            continue
        if bridge is None:
            handle_offline(msg, out)
        else:
            handle_online(bridge, line, msg, out)


def silence_stderr():
    """Points fd 2 at /dev/null: not even interpreter-level messages (e.g. at shutdown) reach agy."""
    try:
        devnull = os.open(os.devnull, os.O_WRONLY)
        os.dup2(devnull, 2)
        os.close(devnull)
    except OSError:
        pass


def main():
    silence_stderr()
    try:
        serve(sys.stdin.buffer, sys.stdout.buffer, os.environ)
    except (BrokenPipeError, KeyboardInterrupt):
        return 0
    except Exception:  # never print a traceback
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
