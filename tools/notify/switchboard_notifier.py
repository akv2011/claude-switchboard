#!/usr/bin/env python3
"""
A notification whenever a Claude Code chat needs you, so you can run many chats without watching them.

tools/notify/install.sh wires it to four hooks in ~/.claude/settings.json:
  Notification  a permission prompt, a question dialog, a plan to approve
  Stop          the chat finished its turn
  StopFailure   the turn died on an API error (rate limit, auth, overload)
  PreToolUse    AskUserQuestion and ExitPlanMode, which may not raise a Notification

Stop pings for every turn you started, so you know the chat is free for the next task. Turns you
did not start (a scheduled check, a background job reporting back, another chat's message) ping
when the reply addresses you, asks a question, reports a problem or a finished job; an unchanged
kind of ping from the same chat repeats at most hourly. A missed ping costs more than an extra one,
so the patterns lean wide. A chat can also ping on purpose, for what no hook sees:
  switchboard_notifier.py "Done: nightly build, 412 tests"
and a turn that did so is not pinged twice.

On the second machine nobody looks at the screen, so with ~/.config/claude-switchboard/notify.json
there the finished banner goes to your main machine over ssh (docs/SHARED-COMPUTE.md, section 8):
  {"forward": {"to": ["you@main.local", "you@100.64.0.1"], "key": "~/.ssh/notify_key", "label": "devbox"}}
Each address in "to" is tried in turn (say, the LAN name, then a VPN address for when you are away).

No model call on purpose: a `claude -p` summary costs about 320 MB and 6 CPU-seconds per turn end.
This is about 27 MB and 0.2 s. Tests: test_notifier.py next to it.

Never blocks and never fails the chat: every error is swallowed, because a broken notifier must not
break Claude.
"""

import glob
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time

HOME = os.path.expanduser("~")
SESSIONS = os.path.join(HOME, ".claude", "sessions")
HOOKS = os.path.join(HOME, ".claude", "hooks")
CONFIG = os.path.join(os.environ.get("XDG_CONFIG_HOME") or os.path.join(HOME, ".config"),
                      "claude-switchboard", "notify.json")
LOG = os.path.join(HOOKS, "switchboard-notify.log")

# Notification types that never need you. idle_prompt fires a minute after every turn end, which
# Stop already handled. Anything not listed pings.
QUIET_NOTIFICATIONS = {"idle_prompt", "auth_success", "elicitation_complete",
                       "elicitation_response", "computer_use_enter", "computer_use_exit"}

# Turns that ping whatever the reply says. auto_continuation is a chat resuming after a usage-limit reset.
ALWAYS_PING = {"human", "auto_continuation"}

STATE = os.path.join(HOOKS, "switchboard-notify-state.json")
REPEAT_SECONDS = 3600

# Tuned on about 1,100 automatic turns over three days: these pinged two in three, and half that
# after the hourly repeat limit. A reply that says "you" is talking to you; that one rule caught
# every real ask in the samples.
ASK = re.compile(r"\byou(r|rs|'re|'d|'ll|'ve)?\b|waiting on|needs? (a )?(decision|go|yes|approval|answer)"
                 r"|blocker|blocked on|\breload|say so|let me know|up to you|\bshould i\b|\bshall i\b"
                 r"|want me to|\bapprove\b|outage|over (the|its) (budget|stop|limit|cap)", re.I)
FAIL = re.compile(r"\b(fail(ed|ing|ure|s)?|errors?|stuck|stall(ed|s|ing)?|crash(ed|es|ing)?|died|dead"
                  r"|(is|went|are) down|broken|blocked|can'?t|cannot|couldn'?t|unable|timed out|quota"
                  r"|rate.?limit(ed)?|out of (space|disk|memory|credit|budget)|paused|halted|stopped"
                  r"|regress(ed|ion))\b", re.I)
DONE = re.compile(r"\b(finished|completed|is complete|all done|(everything|it|this|that|job|build|crawl"
                  r"|deploy|run|task|load|upload|import)( is|'s)? (now )?done|done and|shipped|deployed"
                  r"|merged|went live|is live|landed)\b", re.I)
# Negated mentions ("no failures", "0 errors", "isn't stuck") are not problems.
# can't / couldn't are left out on purpose: those are the problem.
NEG = re.compile(r"\b(no|not|nothing|none|zero|without|never|0)\b[^.,;:\n|]{0,40}"
                 r"|\b(is|was|are|were|does|did|has|have|had)n'?t\b[^.,;:\n|]{0,25}|\w+\s*[=:]\s*0\b", re.I)
# The chat's own all-clear silences problem and done words, never a line addressed to you.
ALL_CLEAR = re.compile(r"no action (is )?needed|nothing (else )?needs (action|doing|you)|nothing (is )?wrong"
                       r"|nothing flagged|no flags|all (is )?(well|good|healthy)", re.I)


def log(line):
    try:
        with open(LOG, "a") as fh:
            fh.write(f"{time.strftime('%F %T')} {line}\n")
    except Exception:
        pass


def registry_entry(session_id):
    for path in glob.glob(os.path.join(SESSIONS, "*.json")):
        try:
            with open(path) as fh:
                entry = json.load(fh)
        except Exception:
            continue
        if str(entry.get("sessionId", "")).lower() == str(session_id).lower():
            return entry
    return {}


def tail_entries(transcript, size=1024 * 1024):
    try:
        with open(transcript, "rb") as fh:
            fh.seek(0, os.SEEK_END)
            end = fh.tell()
            fh.seek(max(0, end - size))
            chunk = fh.read().decode("utf-8", "ignore")
    except Exception:
        return []
    lines = chunk.splitlines()
    if end > size:
        lines = lines[1:]  # first line is torn
    out = []
    for line in lines:
        try:
            out.append(json.loads(line))
        except Exception:
            pass
    return out


def session_name(entry, payload, entries):
    name = entry.get("name")
    # "derived" is Claude Code's folder-based placeholder (projects-d8); the title you set lives in
    # the transcript.
    if name and entry.get("nameSource") != "derived":
        return name
    for e in reversed(entries):
        if e.get("type") == "custom-title" and e.get("customTitle"):
            return e["customTitle"]
    for e in reversed(entries):
        if e.get("type") == "ai-title" and e.get("aiTitle"):
            return e["aiTitle"]
    return name or os.path.basename(payload.get("cwd") or "") or "Claude"


def project_name(cwd):
    # A worktree's own folder says nothing; name the repo it belongs to. Outside a worktree the
    # folder itself is the better name, since one repository may hold many project folders.
    try:
        out = subprocess.run(["git", "-C", cwd, "rev-parse", "--path-format=absolute",
                              "--git-dir", "--git-common-dir"],
                             capture_output=True, text=True, timeout=3).stdout.split()
    except Exception:
        out = []
    if len(out) == 2 and out[0] != out[1] and out[1].endswith("/.git"):
        return os.path.basename(os.path.dirname(out[1]))
    return os.path.basename(cwd or "")


def reply_text(payload, entries):
    text = payload.get("last_assistant_message") or ""
    if text:
        return text
    for e in reversed(entries):
        msg = e.get("message") or {}
        if e.get("type") != "assistant" or not isinstance(msg, dict):
            continue
        parts = [b.get("text", "") for b in msg.get("content") or []
                 if isinstance(b, dict) and b.get("type") == "text"]
        if any(p.strip() for p in parts):
            return "\n".join(parts)
    return ""


def this_turn(entries):
    """(turnOrigin, entries since the prompt that started this turn).
    Origins: human, scheduled, task_notification, peer, system, auto_continuation."""
    for i in range(len(entries) - 1, -1, -1):
        e = entries[i]
        if e.get("type") == "user" and e.get("turnOrigin"):
            return e["turnOrigin"], entries[i + 1:]
    return "human", []  # unknown: treat as yours, so a turn is never silently dropped


def pinged_itself(turn):
    """True when the chat already ran this notifier during this turn."""
    for e in turn:
        for b in (e.get("message") or {}).get("content") or []:
            if isinstance(b, dict) and b.get("type") == "tool_use" \
                    and "switchboard_notifier.py" in str((b.get("input") or {}).get("command", "")):
                return True
    return False


def plain(line):
    return re.sub(r"[*`_#>|]+", "", line).strip(" -")


def question(lines):
    for line in reversed(lines[-3:]):
        if line.endswith("?"):
            return line
    return None


def summarise(reply):
    """(status, body) for a turn you started: a question near the end wins."""
    lines = [plain(l) for l in reply.splitlines() if plain(l)]
    ask = question(lines)
    if ask:
        return "Question for you", ask
    return "Done, ready for more", lines[-1] if lines else "finished its turn"


def classify(reply):
    """(status, line) when a turn you did not start should ping, else None."""
    lines = [plain(l) for l in reply.splitlines() if plain(l)]
    ask = question(lines)
    if ask:
        return "Question for you", ask
    for line in lines:
        if ASK.search(line):
            return "Needs you", line
    if ALL_CLEAR.search(reply):
        return None
    for line in lines:
        if FAIL.search(NEG.sub(" ", line)):
            return "Problem", line
    for line in lines:
        if DONE.search(NEG.sub(" ", line)):
            return "Done", line
    return None


def repeat(session_id, status, now):
    """True if this chat sent the same kind of ping within the hour. Records this ping otherwise.
    A lost write under a race only costs an extra ping."""
    try:
        with open(STATE) as fh:
            state = json.load(fh)
    except Exception:
        state = {}
    last = state.get(session_id)
    if last and last[1] == status and now - last[0] < REPEAT_SECONDS:
        return True
    state = {k: v for k, v in state.items() if now - v[0] < 86400}
    state[session_id] = [now, status]
    tmp = f"{STATE}.{os.getpid()}"
    with open(tmp, "w") as fh:
        json.dump(state, fh)
    os.replace(tmp, STATE)
    return False


def clip(text, limit=95):
    # A banner shows about two lines; past ~95 characters macOS cuts it off.
    text = " ".join(str(text).split())
    return text if len(text) <= limit else text[:limit - 3].rstrip() + "..."


def forward_config(path=CONFIG):
    """The "forward" block of notify.json, or None: this machine shows its own banners."""
    try:
        with open(path) as fh:
            f = json.load(fh).get("forward")
    except Exception:
        return None
    if not isinstance(f, dict) or not f.get("to"):
        return None
    to = f["to"] if isinstance(f["to"], list) else [f["to"]]
    # ssh options or hosts that start with "-" would let the file inject options; refuse them.
    to = [t for t in to if isinstance(t, str) and t and not t.startswith("-")]
    return {"to": to, "key": os.path.expanduser(f.get("key") or "~/.ssh/notify_key"),
            "label": str(f.get("label") or socket.gethostname().split(".")[0])} if to else None


def forward(fwd, name, status, project, body):
    """Hand the finished banner to the main machine; its key may run only `--post-stdin` there."""
    msg = json.dumps({"name": name, "status": status, "project": f"{project} @ {fwd['label']}", "body": body})
    run = None
    for target in fwd["to"]:
        # -4: the key's from= on the main machine lists IPv4 ranges (LAN, Tailscale), and an IPv6
        # connection would be refused there.
        run = subprocess.run(["ssh", "-4", "-i", fwd["key"], "-o", "BatchMode=yes", "-o", "ConnectTimeout=5",
                              "-o", "ControlMaster=no", "-o", "ControlPath=none", "--", target],
                             input=msg + "\n", timeout=15, capture_output=True, text=True)
        if run.returncode == 0:
            return
    log(f"forward failed rc={run.returncode}: {run.stderr.strip()}")


def post(name, status, project, body, fwd=None):
    if fwd:
        forward(fwd, name, status, project, body)
        return
    title = clip(f"Claude · {name}", 60)
    subtitle = clip(f"{status} · {project}" if project else status, 60)
    if sys.platform != "darwin":
        if not shutil.which("notify-send"):
            log("no notify-send here; on a headless machine, forward the banners (notify.json)")
            return
        run = subprocess.run(["notify-send", "--app-name=Claude Code", title, f"{subtitle}\n{clip(body)}"],
                             timeout=10, capture_output=True, text=True)
        if run.returncode:
            log(f"notify-send rc={run.returncode}: {run.stderr.strip()}")
        return
    # The sound goes straight through afplay: it needs no notification permission, so the ping
    # arrives even when banners are blocked. It is the alert sound chosen in System Settings > Sound,
    # read each time so a change there is followed here.
    try:
        sound = subprocess.run(["defaults", "read", "-g", "com.apple.sound.beep.sound"],
                               capture_output=True, text=True, timeout=5).stdout.strip()
    except Exception:
        sound = ""
    if not os.path.exists(sound):
        sound = "/System/Library/Sounds/Funk.aiff"
    subprocess.Popen(["afplay", sound], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    # The banner goes through osascript (it posts as Script Editor). terminal-notifier exits 0 and
    # shows nothing on recent macOS on Apple silicon. The text goes in as argv, never spliced into
    # the script: AppleScript has no \\uXXXX escape, so escaped text could break the script.
    run = subprocess.run(
        ["osascript", "-e", "on run argv",
         "-e", "display notification (item 1 of argv) with title (item 2 of argv) subtitle (item 3 of argv)",
         "-e", "end run", clip(body), title, subtitle],
        timeout=10, capture_output=True, text=True)
    if run.returncode:
        log(f"osascript rc={run.returncode}: {run.stderr.strip()}")


def main():
    if sys.argv[1:] == ["--post-stdin"]:
        # A banner from the second machine, which decided what to say; its ssh key's authorized_keys
        # entry forces this exact command. Shown here, never forwarded again.
        b = json.loads(sys.stdin.readline())
        post(str(b.get("name") or "remote"), str(b.get("status") or "Update"),
             str(b.get("project") or ""), str(b.get("body") or ""))
        return
    # Programmatic runs (claude -p, the SDK) are not chats you sit in front of.
    if os.environ.get("CLAUDE_CODE_ENTRYPOINT", "").startswith("sdk"):
        return
    if len(sys.argv) > 1:
        # Called by a chat itself, for what no hook sees: a background job finishing or failing,
        # or a question during a scheduled check.
        sid = os.environ.get("CLAUDE_CODE_SESSION_ID", "")
        found = glob.glob(os.path.join(HOME, ".claude", "projects", "*", f"{sid}.jsonl")) if sid else []
        payload = {"hook_event_name": "Manual", "session_id": sid, "cwd": os.getcwd(),
                   "transcript_path": found[0] if found else "",
                   "message": " ".join(sys.argv[1:])}
    else:
        try:
            payload = json.load(sys.stdin)
        except Exception:
            return

    event = payload.get("hook_event_name", "")
    kind = payload.get("notification_type", "")
    message = payload.get("message") or ""
    if event == "Notification" and (kind in QUIET_NOTIFICATIONS or "waiting for your input" in message):
        return

    entries = tail_entries(payload.get("transcript_path") or "")
    if event == "Stop":
        origin, turn = this_turn(entries)
        reply = reply_text(payload, entries)
        if origin in ALWAYS_PING:
            status, body = summarise(reply)
        else:
            found = None if pinged_itself(turn) else classify(reply)
            if not found or repeat(payload.get("session_id", ""), found[0], time.time()):
                return
            status, body = found

    entry = registry_entry(payload.get("session_id", ""))
    name = session_name(entry, payload, entries)
    # The folder the chat started in: a later `cd` into a scratch folder is not the project.
    project = project_name(entry.get("cwd") or payload.get("cwd") or "")

    if event == "Stop":
        pass  # status and body set above
    elif event == "StopFailure":
        status = "Stopped, API error"
        body = ": ".join(str(x) for x in (payload.get("error"), payload.get("error_details")) if x) \
            or "the turn failed; open the chat"
    elif event == "PreToolUse":
        # A question dialog or a plan to approve: Claude Code may not raise a Notification for
        # these, so ping here and accept the odd double.
        if payload.get("tool_name") == "ExitPlanMode":
            status, body = "Plan to approve", "the plan is ready for your approval"
        else:
            qs = (payload.get("tool_input") or {}).get("questions") or [{}]
            status, body = "Question for you", qs[0].get("question") or "a question is waiting"
    elif event == "Manual":
        # "Done: x" / "Error: x" / "Question: x" -> status and body.
        head, sep, rest = message.partition(":")
        status, body = (head.strip(), rest.strip()) if sep and len(head) <= 20 else ("Update", message)
    else:  # Notification: a permission prompt, a question dialog, a plan to approve
        status = "Needs permission" if kind == "permission_prompt" else "Needs you"
        body = message or "needs your input"

    post(name, status, project, body, forward_config())


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
