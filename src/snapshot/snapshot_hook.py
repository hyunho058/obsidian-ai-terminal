#!/usr/bin/env python3
"""Claude Code UserPromptSubmit hook of the Obsidian AI Terminal plugin (D31, R12.3).

Asks the plugin to snapshot the vault before Claude sees the message: POSTs
{panelId, prompt (first 200 characters), ai: "claude"} to $OBSIDIAN_BRIDGE_URL/snapshot with the bridge token and
waits at most 10 s. It always exits 0 and prints nothing: a UserPromptSubmit hook's stdout would be added to
Claude's context, and exit code 2 would block the message. Without the bridge variables (Claude started outside
Obsidian) it does nothing. Python standard library only, Python >= 3.9.
"""

import json
import os
import sys
import urllib.parse
import urllib.request

TIMEOUT_S = 10.0
MAX_PROMPT_CHARS = 200
URL_ENV = "OBSIDIAN_BRIDGE_URL"
TOKEN_ENV = "OBSIDIAN_BRIDGE_TOKEN"
PANEL_ENV = "OBSIDIAN_PANEL_ID"
REDACTED = "[REDACTED]"


def build_request(base_url, token, panel_id, prompt):
    body = json.dumps({"panelId": panel_id, "prompt": prompt, "ai": "claude"}).encode("utf-8")
    return urllib.request.Request(
        base_url.rstrip("/") + "/snapshot",
        data=body,
        method="POST",
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + token},
    )


def read_prompt(stream, token=""):
    try:
        data = json.loads(stream.read().decode("utf-8", "replace"))
    except Exception:
        return ""
    prompt = data.get("prompt") if isinstance(data, dict) else None
    if not isinstance(prompt, str):
        return ""
    # Redact before cutting: a token cut in half at the limit could no longer be recognised by the plugin.
    if token:
        for form in (token, urllib.parse.quote(token, safe="")):
            prompt = prompt.replace(form, REDACTED)
    return prompt[:MAX_PROMPT_CHARS]


def main(env=None, stdin=None):
    env = os.environ if env is None else env
    base_url = env.get(URL_ENV, "")
    token = env.get(TOKEN_ENV, "")
    if not base_url or not token:
        return
    prompt = read_prompt(stdin if stdin is not None else sys.stdin.buffer, token)
    request = build_request(base_url, token, env.get(PANEL_ENV, ""), prompt)
    # The bridge is on 127.0.0.1: never route it through a proxy from the environment.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request, timeout=TIMEOUT_S) as response:
        response.read()


def run():
    try:
        sys.stdout = sys.stderr = open(os.devnull, "w")
    except Exception:
        pass
    try:
        main()
    except BaseException:
        pass
    os._exit(0)


if __name__ == "__main__":
    run()
