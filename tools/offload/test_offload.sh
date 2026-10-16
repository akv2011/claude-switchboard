#!/bin/bash
# End-to-end check of offload against a real remote machine. Uses throwaway projects under the
# projects folder and removes them, their Mutagen session, jobs and forwards on both machines.
#   OFFLOAD_HOST=devbox OFFLOAD_PROJECTS=~/Projects tools/offload/test_offload.sh
# Needs: mutagen, an ssh alias with key login, tmux and python3 on the remote, 13 GB free here.
set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")" && pwd)/offload"
HOST=${OFFLOAD_HOST:?set OFFLOAD_HOST to the remote ssh alias}
PROJECTS=${OFFLOAD_PROJECTS:-$HOME/Projects}
PROJECTS=${PROJECTS/#\~/$HOME}
export OFFLOAD_HOST OFFLOAD_PROJECTS=$PROJECTS
ROOT_PREFIX=$PROJECTS/offload-selftest-
RAND=$(openssl rand -hex 4)
P=$ROOT_PREFIX$RAND
BIG=${ROOT_PREFIX}${RAND}big
JOB=selftest-$RAND
HTTPJOB=selftest-http-$RAND
T=$(mktemp -d)
PORT=
pass=0
fail=0

ok() { echo "PASS $1"; pass=$((pass + 1)); }
bad() { echo "FAIL $1"; fail=$((fail + 1)); }
check() { local label=$1; shift; if "$@"; then ok "$label"; else bad "$label"; fi; }
offload() { "$SCRIPT" "$@"; }
d() { (cd "$P" && offload "$@"); }
now() { perl -MTime::HiRes=time -e 'printf "%.2f", time'; }
fwd_pat() { echo "^ssh -fN -o ControlPath=none -o ControlMaster=no -o ExitOnForwardFailure=yes -L $1:localhost:$1 $HOST\$"; }
sessions_for() {
  mutagen sync list --label-selector offload \
    --template '{{range .}}{{if eq .Alpha.Path "'"$1"'"}}{{.Identifier}} {{.Name}}{{"\n"}}{{end}}{{end}}' 2>/dev/null || true
}

cleanup() {
  set +e
  [ -n "$PORT" ] && pkill -f "$(fwd_pat "$PORT")"
  ssh "$HOST" "tmux kill-session -t '=$JOB' 2>/dev/null; tmux kill-session -t '=$HTTPJOB' 2>/dev/null
    rm -rf '$P' '$BIG' ~/.offload/logs/$JOB.log ~/.offload/logs/$HTTPJOB.log"
  local id rest
  sessions_for "$P" | while read -r id rest; do [ -n "$id" ] && mutagen sync terminate "$id" >/dev/null; done
  rm -rf "$P" "$BIG" "$T"
  rm -f "$HOME/.offload/locks/offload-offload-selftest-$RAND"*.lock
  echo "cleanup: sessions left for $P: $(sessions_for "$P" | grep -c .)," \
    "local dir exists: $([ -e "$P" ] && echo yes || echo no)," \
    "remote dir exists: $(ssh "$HOST" "[ -e '$P' ] && echo yes || echo no")"
}
trap cleanup EXIT

echo "mutagen $(mutagen version), project $P"

mkdir -p "$P/sub/dir"
git -C "$P" init -q
echo v1 >"$P/hello.txt"

rc=0; (cd "$PROJECTS" && offload true) 2>"$T/err" || rc=$?
check "refuses the projects folder itself (rc=$rc: $(cat "$T/err"))" [ "$rc" = 1 ]
rc=0; (cd "$HOME" && offload true) 2>"$T/err" || rc=$?
check "refuses the home dir (rc=$rc: $(cat "$T/err"))" [ "$rc" = 1 ]

mkdir "$T/fakebin"
printf '#!/bin/sh\nexit 255\n' >"$T/fakebin/ssh"
chmod +x "$T/fakebin/ssh"
rc=0; (cd "$P" && PATH=$T/fakebin:$PATH "$SCRIPT" true) 2>"$T/err" || rc=$?
check "unreachable remote exits 255 with one line (rc=$rc: $(cat "$T/err"))" \
  [ "$rc" = 255 -a "$(wc -l <"$T/err" | tr -d ' ')" = 1 ]
check "no session created while the remote was unreachable" [ -z "$(sessions_for "$P")" ]

t0=$(now)
(cd "$P" && offload sh -c 'echo A >conc_a.txt; echo out-A') >"$T/a.out" 2>"$T/a.err" &
pa=$!
(cd "$P" && offload sh -c 'echo B >conc_b.txt; echo out-B') >"$T/b.out" 2>"$T/b.err" &
pb=$!
ra=0; wait "$pa" || ra=$?
rb=0; wait "$pb" || rb=$?
echo "INFO two concurrent cold-start calls took $(echo "$(now) - $t0" | bc) s"
check "concurrent call A ok (rc=$ra, out=$(cat "$T/a.out"))" [ "$ra" = 0 -a "$(cat "$T/a.out")" = out-A ]
check "concurrent call B ok (rc=$rb, out=$(cat "$T/b.out"))" [ "$rb" = 0 -a "$(cat "$T/b.out")" = out-B ]
check "both concurrent calls' files are here" \
  [ "$(cat "$P/conc_a.txt" 2>/dev/null)" = A -a "$(cat "$P/conc_b.txt" 2>/dev/null)" = B ]
sessions=$(sessions_for "$P")
check "exactly one sync session for the project (got $(printf '%s' "$sessions" | grep -c . || true))" \
  [ "$(printf '%s\n' "$sessions" | grep -c .)" = 1 ]
creates=$(cat "$T/a.err" "$T/b.err" | grep -c 'creating sync session' || true)
check "only one of the two racing calls created the session (creators: $creates)" [ "$creates" = 1 ]
NAME=$(printf '%s\n' "$sessions" | awk 'NR == 1 { print $2 }')
echo "INFO session name $NAME"

check "Mutagen daemon is running" pgrep -qf 'mutagen daemon run'
check "Mutagen daemon is not registered with launchd" \
  sh -c '! launchctl print "gui/$(id -u)/io.mutagen.mutagen" >/dev/null 2>&1 && [ ! -e ~/Library/LaunchAgents/io.mutagen.mutagen.plist ]'

echo v2 >"$P/hello.txt"
out=$(d cat hello.txt)
check "a local edit is visible to a remote cat (got $out)" [ "$out" = v2 ]
err=$(d true 2>&1 >/dev/null)
check "a clean call prints nothing on stderr (got: $err)" [ -z "$err" ]

out=$(cd "$P/sub/dir" && offload pwd)
check "runs in the same directory from a subfolder (got $out)" [ "$out" = "$P/sub/dir" ]

d sh -c 'echo made-remotely >from_remote.txt'
check "a file created on the remote is here when offload returns" \
  [ "$(cat "$P/from_remote.txt" 2>/dev/null)" = made-remotely ]

rc=0; d sh -c 'exit 3' || rc=$?
check "remote exit code 3 propagates (rc=$rc)" [ "$rc" = 3 ]

out=$(d tty 2>&1 || true)
check "no tty is allocated when not run from a terminal (got $out)" [ "$out" = "not a tty" ]
out=$(cd "$P" && script -q /dev/null "$SCRIPT" tty </dev/null | tr -d '\r' | tr '\n' ' ')
check "a tty is allocated when run from a terminal, with no ssh chatter (got $out)" \
  sh -c 'case "$1" in *Shared*) exit 1 ;; */dev/pts/*) exit 0 ;; esac; exit 1' _ "$out"
rc=0; (cd "$P" && script -q /dev/null "$SCRIPT" sh -c 'exit 4' </dev/null >/dev/null) || rc=$?
check "exit code propagates through the tty path too (rc=$rc)" [ "$rc" = 4 ]

args=("a b  c" "it's 'quoted'" '$HOME' '*' '==' '=ls' "two
lines" '' 'semi;colon && $(echo no) `echo no`')
want=$(printf '[%s]\n' "${args[@]}")
got=$(d printf '[%s]\n' "${args[@]}")
check "args with spaces, quotes, \$HOME, *, ==, =ls, newline, empty arrive intact" [ "$got" = "$want" ]
[ "$got" = "$want" ] || diff <(echo "$want") <(echo "$got") || true

d sh -c 'mkdir -p node_modules/pkg && echo x >node_modules/pkg/index.js'
check "node_modules exists on the remote" ssh "$HOST" "test -f '$P/node_modules/pkg/index.js'"
check "node_modules made on the remote did not come back" [ ! -e "$P/node_modules" ]

check ".git exists here" [ -d "$P/.git" ]
check ".git is not on the remote" ssh "$HOST" "test ! -e '$P/.git'"

modes=$(ssh "$HOST" "stat -c %a '$P/hello.txt' '$P/sub'" | tr '\n' ' ')
check "remote file and dir modes are 0644 and 0755 (got $modes)" [ "$modes" = "644 755 " ]

mutagen sync pause "$NAME" >/dev/null
echo local-side >"$P/conflict.txt"
ssh "$HOST" "echo remote-side >'$P/conflict.txt'"
mutagen sync resume "$NAME" >/dev/null
rc=0; d true 2>"$T/err" || rc=$?
hits=$(grep -c "conflict at $P/conflict.txt" "$T/err" || true)
check "conflict is printed to stderr without failing the command (rc=$rc: $(cat "$T/err"))" \
  [ "$rc" = 0 -a "$hits" = 1 ]
status_line=$(offload status | grep -F "$NAME" || true)
echo "INFO offload status: $status_line"
check "offload status shows the session watching with 1 conflict" \
  sh -c 'case "$1" in *Watching*conflicts=1*) exit 0;; esac; exit 1' _ "$status_line"
rm "$P/conflict.txt"
ssh "$HOST" "rm '$P/conflict.txt'"

printf '# selftest\n  secret_dir  \n\n' >"$P/.offloadignore"
rc=0; d true 2>"$T/err" || rc=$?
hits=$(grep -c recreating "$T/err" || true)
check "changed .offloadignore recreates the session (rc=$rc: $(tr '\n' ' ' <"$T/err"))" \
  [ "$rc" = 0 -a "$hits" = 1 ]
mkdir -p "$P/secret_dir" && echo s >"$P/secret_dir/f"
check "an .offloadignore pattern keeps its path off the remote" d test ! -e secret_dir/f
check "still exactly one session after recreating" [ "$(sessions_for "$P" | grep -c .)" = 1 ]

d -d "$JOB" sh -c 'pwd; echo job-started; sleep 300' 2>"$T/err"
logs=
for _ in $(seq 1 50); do
  logs=$(d logs "$JOB" 2>/dev/null || true)
  case $logs in *job-started*) break ;; esac
  sleep 0.2
done
check "offload -d job writes its log, in the project dir (log: $(echo "$logs" | tr '\n' ' '))" \
  [ "$logs" = "$P
job-started" ]
check "offload ls lists the job" sh -c '"$2" ls | grep -q "^$1:"' _ "$JOB" "$SCRIPT"
d stop "$JOB"
check "offload stop ends the job" sh -c '! "$2" ls | grep -q "^$1:"' _ "$JOB" "$SCRIPT"

for _ in $(seq 1 20); do
  PORT=$((40000 + RANDOM % 20000))
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && continue
  ssh "$HOST" "ss -ltnH | awk '{print \$4}' | grep -q ':$PORT\$'" && continue
  break
done
echo "INFO port $PORT"
d -d "$HTTPJOB" python3 -m http.server "$PORT" --bind 127.0.0.1 2>/dev/null
for _ in $(seq 1 50); do
  ssh "$HOST" "curl -fs localhost:$PORT/hello.txt" >/dev/null 2>&1 && break
  sleep 0.2
done
offload -p "$PORT" 2>"$T/err"
got=$(curl -fs "localhost:$PORT/hello.txt" || true)
check "offload -p: the remote http.server answers on localhost:$PORT (got $got)" [ "$got" = v2 ]
offload -p "$PORT" 2>"$T/err"
check "offload -p again is a no-op ($(cat "$T/err"); forwarders $(pgrep -f "$(fwd_pat "$PORT")" | wc -l | tr -d ' '))" \
  [ "$(pgrep -f "$(fwd_pat "$PORT")" | wc -l | tr -d ' ')" = 1 ]
offload -p stop "$PORT" 2>/dev/null
check "offload -p stop closes the forward" sh -c '! curl -fs --max-time 2 "localhost:$1/hello.txt" >/dev/null 2>&1' _ "$PORT"
d stop "$HTTPJOB"

t0=$(now)
d true
echo "INFO warm offload true took $(echo "$(now) - $t0" | bc) s"

mkdir -p "$BIG/node_modules"
echo small >"$BIG/small.txt"
mkfile -n 6g "$BIG/big.bin"
mkfile -n 6g "$BIG/node_modules/ignored.bin"
rc=0; (cd "$BIG" && offload true) 2>"$T/err" || rc=$?
hits=$(grep -c ' 6.4 GB after ignores' "$T/err" || true)
check "size guard refuses 6 GiB outside node_modules, not 12.9 with it (rc=$rc: $(cat "$T/err"))" \
  [ "$rc" = 1 -a "$hits" = 1 ]
check "no session created for the oversized project" [ -z "$(sessions_for "$BIG")" ]

echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
