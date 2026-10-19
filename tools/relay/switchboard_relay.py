#!/usr/bin/env python3
# A Claude Code hook for Claude Switchboard's relay (src/core/peer-relay.js), which mirrors each
# chat's message socket onto the other machine. Claude Code lists only its own machine's chats,
# so this fills the gap from ~/.claude-switchboard/remote-peers.json:
# - UserPromptSubmit: a prompt naming @<chat> for a chat on the other machine gets that chat's
#   address, so "@build-bot run the tests" works from either machine.
# - PreToolUse on SendMessage: a name, or a `from` address, that only the other machine has goes
#   to its mirror here. Claude Code looks names up on its own machine only, and a reply goes to
#   the address the message came from, which exists only on the machine that sent it.
# A chat of that name or address on this machine always wins.
# Install with tools/relay/install.sh; run with --selftest to check it.
import glob, json, os, re, sys

PEERS = os.path.expanduser("~/.claude-switchboard/remote-peers.json")


def tmux_name(name):
    return re.sub(r"[^A-Za-z0-9_-]", "_", name)[:50]


def names_of(p):
    return {p["name"].lower(), tmux_name(p["name"]).lower()}


def mentioned(prompt, peers):
    # @name standing alone: not the end of an email address, and not the start of a longer name.
    hit = lambda n: re.search(rf"(?<![\w.%+-])@{re.escape(n)}(?![\w-])", prompt, re.I)
    return [p for p in peers if p.get("name") and any(hit(n) for n in {p["name"], tmux_name(p["name"])})]


def on_prompt(event, peers):
    found = mentioned(event.get("prompt") or "", peers)
    if not found:
        return None
    lines = [f"{p['name']} is a chat on {p['machine']}, not this machine, so ListAgents does not show it. "
             f"Message it with SendMessage to \"{p['to']}\"; its reply comes back as a cross-session message." for p in found]
    return {"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": "\n".join(lines)}}


def local_chats():
    """Names and socket addresses of the chats running on this machine, from Claude Code's registry."""
    names, addrs = set(), set()
    for f in glob.glob(os.path.expanduser("~/.claude/sessions/*.json")):
        try:
            with open(f) as fh:
                s = json.load(fh)
            os.kill(int(s["pid"]), 0)
        except (OSError, ValueError, KeyError, TypeError):
            continue
        if s.get("name"):
            names.add(s["name"].lower())
        if s.get("messagingSocketPath"):
            addrs.add(f"uds:{s['messagingSocketPath']}")
    return names, addrs


def on_send(event, peers, here=None):
    tool_input = event.get("tool_input") or {}
    to = str(tool_input.get("to", ""))
    if not to:
        return None
    names, addrs = local_chats() if here is None else here
    if to.startswith("uds:"):
        if to in addrs:
            return None
        hit = [p for p in peers if p.get("addr") == to]
    elif ":" not in to:
        if to.lower() in names:
            return None
        hit = [p for p in peers if p.get("name") and to.lower() in names_of(p)]
    else:
        return None
    if len(hit) != 1:
        return None
    return {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow",
                                   "permissionDecisionReason": f"{hit[0]['name']} runs on {hit[0]['machine']}",
                                   "updatedInput": {**tool_input, "to": hit[0]["to"]}}}


def selftest():
    peers = [{"name": "build-bot", "to": "uds:/tmp/cc-socks-1000501/4242.sock", "addr": "uds:/tmp/cc-socks/4242.sock", "machine": "the Mac"},
             {"name": "Web UI (2)", "to": "uds:/tmp/cc-socks-1001000/77.sock", "addr": "uds:/run/user/1000/cc-socks/77.sock", "machine": "devbox"}]
    out = on_prompt({"prompt": "ask @Build-Bot to run the tests"}, peers)
    assert "uds:/tmp/cc-socks-1000501/4242.sock" in out["hookSpecificOutput"]["additionalContext"], out
    assert "Web UI" not in out["hookSpecificOutput"]["additionalContext"], "only the chat named"
    assert on_prompt({"prompt": "tell @Web_UI__2_ hi"}, peers) is not None, "the tmux form of a name"
    assert on_prompt({"prompt": "mail me@build-botnet.example"}, peers) is None, "an email address is no mention"
    assert on_prompt({"prompt": "(@build-bot) please"}, peers) is not None
    assert on_prompt({"prompt": "no mention here"}, peers) is None
    nobody = (set(), set())
    reply = on_send({"tool_input": {"to": "uds:/run/user/1000/cc-socks/77.sock", "message": "done"}}, peers, nobody)
    assert reply["hookSpecificOutput"]["updatedInput"] == {"to": "uds:/tmp/cc-socks-1001000/77.sock", "message": "done"}, "a reply to the other machine's address"
    named = on_send({"tool_input": {"to": "build-bot", "message": "status?"}}, peers, nobody)
    assert named["hookSpecificOutput"]["updatedInput"]["to"] == "uds:/tmp/cc-socks-1000501/4242.sock", "a name only the other machine runs"
    assert on_send({"tool_input": {"to": "build-bot"}}, peers, ({"build-bot"}, set())) is None, "a chat of that name here wins"
    assert on_send({"tool_input": {"to": "uds:/tmp/cc-socks/4242.sock"}}, peers, (set(), {"uds:/tmp/cc-socks/4242.sock"})) is None, "an address alive here wins"
    assert on_send({"tool_input": {"to": "nobody"}}, peers, nobody) is None
    assert on_send({"tool_input": {"to": "bridge:abc"}}, peers, nobody) is None
    print("switchboard_relay selftest ok")


def main():
    if "--selftest" in sys.argv:
        return selftest()
    event = json.load(sys.stdin)
    try:
        with open(PEERS) as f:
            peers = json.load(f)
    except (OSError, ValueError):
        return
    out = on_send(event, peers) if event.get("hook_event_name") == "PreToolUse" else on_prompt(event, peers)
    if out:
        print(json.dumps(out))


if __name__ == "__main__":
    main()
