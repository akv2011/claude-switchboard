"""Checks for switchboard_notifier.py. Run: python3 tools/notify/test_notifier.py
The replies below have the shapes of real chat replies: asks the first version left quiet, and
routine reports that must stay quiet."""

import importlib.util
import json
import os
import tempfile

spec = importlib.util.spec_from_file_location(
    "notify", os.path.join(os.path.dirname(os.path.abspath(__file__)), "switchboard_notifier.py"))
n = importlib.util.module_from_spec(spec)
spec.loader.exec_module(n)

# Each must ping.
MUST_PING = [
    "Five profiles are still on 1.22, waiting for your reload to 1.23.",
    "- **Waiting on you:** the extension reload to 1.6 in the work browser profile",
    "The import tab needs reloading in the browser profile before new pages load again.",
    "I'll dig into it once you're up and the three are reloaded.",
    "If you'd rather not get the email, say so and the CI chat will raise it.",
    "Separately, this chat can't connect to the browser profile right now.",
    "The blocker has not moved: the CI repo has no secrets.",
    "Everything on my side is done and committed: all five sources crawled.",
    "The import worker (pid 41253) has stopped, minutes after the build chat reported it healthy.",
    "2. After that, **route `example.net`**, or hold for the re-crawl decisions?",
]
# Routine reports. Each must stay quiet.
MUST_STAY_QUIET = [
    "| refusals | 4 challenges (403) |\n| proxy | 2.98 of 10 GB used |\n| ETA | about 7.3 days |",
    "The page-load probe ran 36 fetches in the last hour with no stalls and no cut-off pages, so nothing needs action.",
    "The poller's latest line is done=20 errors=0.",
    "The warm queue hasn't moved this hour: 8 books done, none waiting.",
    "The database stayed healthy this hour. Nothing needs action.",
]

for text in MUST_PING:
    assert n.classify(text), f"should ping: {text}"
for text in MUST_STAY_QUIET:
    assert not n.classify(text), f"should stay quiet: {text} -> {n.classify(text)}"

# A turn you started: a question near the end wins, else "ready for more".
assert n.summarise("Built it.\n\nShould I also add X?\n\nThe code is in notifier.py.")[0] == "Question for you"
assert n.summarise("Built it. All tests pass.")[0] == "Done, ready for more"

# Hourly repeat limit, per chat and per kind of ping.
n.STATE = os.path.join(tempfile.mkdtemp(), "state.json")
assert not n.repeat("s1", "Needs you", 1000)
assert n.repeat("s1", "Needs you", 1000 + 600)          # same kind, 10 min later: quiet
assert not n.repeat("s1", "Problem", 1000 + 700)        # new kind: pings
assert not n.repeat("s2", "Problem", 1000 + 700)        # other chat: pings
assert not n.repeat("s1", "Problem", 1000 + 700 + 3601)  # same kind after an hour: pings again

# A turn where the chat ran the notifier itself is not pinged twice.
turn = [{"type": "assistant", "message": {"content": [
    {"type": "tool_use", "name": "Bash", "input": {"command": "python3 ~/.claude/hooks/switchboard_notifier.py 'Error: x'"}}]}}]
assert n.pinged_itself(turn) and not n.pinged_itself([])

# Forwarding: off without notify.json; on with it; an option-like address is refused.
d = tempfile.mkdtemp()
cfg = os.path.join(d, "notify.json")
assert n.forward_config(cfg) is None, "no file: banners show here"
with open(cfg, "w") as fh:
    json.dump({"forward": {"to": ["you@main.local", "-oProxyCommand=x", "you@100.64.0.1"], "label": "devbox"}}, fh)
f = n.forward_config(cfg)
assert f["to"] == ["you@main.local", "you@100.64.0.1"] and f["label"] == "devbox", f
assert f["key"] == os.path.expanduser("~/.ssh/notify_key")
with open(cfg, "w") as fh:
    json.dump({"forward": {"to": "you@main.local", "key": "~/.ssh/other"}}, fh)
f = n.forward_config(cfg)
assert f["to"] == ["you@main.local"] and f["key"].endswith("/.ssh/other") and f["label"], f
with open(cfg, "w") as fh:
    fh.write("not json")
assert n.forward_config(cfg) is None, "a broken file shows banners here instead of failing"

print(f"ok: {len(MUST_PING)} asks ping, {len(MUST_STAY_QUIET)} routine reports stay quiet, "
      "repeat limit, self-ping dedupe and forward settings hold")
