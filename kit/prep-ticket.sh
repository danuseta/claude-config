#!/usr/bin/env bash
# Prepare isolated worktrees for one ticket. Idempotent: an existing worktree is reused.
#   prep-ticket.sh <KEY> <slug> <be-base|-> <fe-base|-> "<title>"
#   e.g. prep-ticket.sh QRD-1387 remove-assignment origin/feat/V1-Playbook origin/feat/V1-Playbook "Remove an assignment"
set -eu
KEY=$1; SLUG=$2; BE_BASE=$3; FE_BASE=$4; TITLE=${5:-$KEY}
ROOT="E:/qonflo"; KIT="C:/Users/danus/.claude-kantor/kit"
NUM=${KEY##*-}; LOW=$(echo "$KEY" | tr 'A-Z' 'a-z' | tr -d '-' | sed 's/qrd//')
BRANCH="feat/$KEY-$SLUG"
BP=$((3100 + NUM % 100)); FP=$((5200 + NUM % 100))
# Linux: root, kit folder and port bases come from paths.cjs. Everything below runs unchanged.
if [ "$(uname -s)" = Linux ]; then
	KIT=$(cd "$(dirname "$0")" && pwd -P)
	cfg() { node "$KIT/paths.cjs" --print | node -e 'const p=JSON.parse(require("fs").readFileSync(0,"utf8"));const v=process.argv[1].split(".").reduce((o,k)=>o[k],p);console.log(v)' "$1"; }
	ROOT=$(cfg root)
	BP=$(($(cfg ticketPortBase.be) + NUM % 100)); FP=$(($(cfg ticketPortBase.fe) + NUM % 100))
fi

make() {
	local repo=$1 dir=$2 base=$3
	[ "$base" = "-" ] && return 0
	bash "$KIT/wt.sh" add "$repo" "$dir" "$BRANCH" "$base"
}

BE_DIR="$ROOT/wt-$LOW-be"; FE_DIR="$ROOT/wt-$LOW-fe"
make be "$BE_DIR" "$BE_BASE"
make fe "$FE_DIR" "$FE_BASE"
[ "$BE_BASE" = "-" ] && BE_DIR=""
[ "$FE_BASE" = "-" ] && FE_DIR=""
node "$KIT/status.cjs" init "$KEY" "$TITLE" "$BP" "$FP" "$BE_DIR" "$FE_DIR"
echo "KEY=$KEY BRANCH=$BRANCH BE=$BE_DIR:$BP FE=$FE_DIR:$FP"
