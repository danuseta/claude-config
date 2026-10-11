#!/usr/bin/env bash
# Worktrees for the Qonflo repos. The only supported way to add or remove one: `git worktree` is not called directly.
#   wt.sh add <be|fe> <dir> <branch> <base>   create the worktree, give it node_modules and the env files. Idempotent.
#   wt.sh own <dir>                           replace a node_modules junction with the worktree's own install (pnpm worktrees only)
#   wt.sh unlink <dir>                        take the node_modules junction away without touching what it points at
#   wt.sh remove <dir>                        remove the worktree; refuses while a node_modules junction is still attached
#   wt.sh check <dir>                         what node_modules is: junction, own, or none
# A pnpm worktree gets its own node_modules (hardlinks from the store, so no disk is spent). An npm worktree keeps a junction
# to the main repo's node_modules, and `git worktree remove` deletes THROUGH a junction, which is why remove refuses.
set -eu
ROOT="${QONFLO_ROOT:-E:/qonflo}"
G="git -c safe.directory=*"

repo_of() {
	case "$1" in
		be) echo "$ROOT/ms-admin-worker-backend";;
		fe) echo "$ROOT/ms-client-dashboard-frontend";;
		*) echo "repo must be be or fe, got $1" >&2; exit 1;;
	esac
}
win() { cygpath -w "$1"; }
# junction | own | none
modules() {
	node -e "try{const s=require('fs').lstatSync(process.argv[1]+'/node_modules');console.log(s.isSymbolicLink()?'junction':'own')}catch{console.log('none')}" "$1"
}
# The main repo a worktree belongs to.
main_of() { dirname "$(cd "$1" && $G rev-parse --path-format=absolute --git-common-dir)"; }
bin_state() { [ -d "$1/node_modules/.bin" ] && echo present || echo absent; }
# Everything below own/unlink/remove deletes something, so it only ever runs on a linked worktree, never on a main repo.
need_linked() {
	local git_dir common
	git_dir=$(cd "$1" && $G rev-parse --path-format=absolute --git-dir) || { echo "REFUSED: $1 is not a git worktree"; exit 2; }
	common=$(cd "$1" && $G rev-parse --path-format=absolute --git-common-dir)
	[ "$git_dir" != "$common" ] || { echo "REFUSED: $1 is a main repo, not a linked worktree"; exit 2; }
	[ "$(cd "$1" && $G rev-parse --show-toplevel | tr 'A-Z' 'a-z')" = "$(cd "$1" && (pwd -W 2>/dev/null || pwd) | tr 'A-Z' 'a-z')" ] || { echo "REFUSED: $1 is not the top folder of its worktree"; exit 2; }
}
unlink_modules() {
	[ "$(modules "$1")" = junction ] || return 0
	cmd //c rmdir "$(win "$1/node_modules")"
	[ "$(modules "$1")" = none ] || { echo "REFUSED: the junction at $1/node_modules is still there"; exit 2; }
}
install_own() {
	(cd "$1" && pnpm install --frozen-lockfile --offline --silent) || { echo "FAILED: pnpm install in $1; the store may lack a package this lockfile needs (run it once without --offline)"; exit 1; }
}

cmd=${1:-}; shift || true
# Paths end up inside cmd and PowerShell command lines, so only plain path characters are accepted.
for arg in "$@"; do
	case "$arg" in *[!A-Za-z0-9:/\\_.@-]*) echo "REFUSED: unsupported character in \"$arg\""; exit 2;; esac
done
case "$cmd" in
	add) [ $# -eq 4 ] || { echo "usage: wt.sh add <be|fe> <dir> <branch> <base>"; exit 1; };;
	own|unlink|remove|check) [ $# -eq 1 ] || { echo "usage: wt.sh $cmd <dir>"; exit 1; };;
esac
# Linux: node_modules links are symlinks, removed with plain rm only (never rm -r on a link), so the target survives.
# These helpers replace the Windows ones above, so own, unlink and check run unchanged. add and remove carry inline Windows commands and are handled here.
if [ "$(uname -s)" = Linux ]; then
	KITDIR=$(cd "$(dirname "$0")" && pwd -P)
	ROOT=$(node "$KITDIR/paths.cjs" --print | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).root)')
	modules() { if [ -L "$1/node_modules" ]; then echo junction; elif [ -e "$1/node_modules" ]; then echo own; else echo none; fi; }
	need_linked() {
		local git_dir common
		git_dir=$(cd "$1" && $G rev-parse --path-format=absolute --git-dir) || { echo "REFUSED: $1 is not a git worktree"; exit 2; }
		common=$(cd "$1" && $G rev-parse --path-format=absolute --git-common-dir)
		[ "$git_dir" != "$common" ] || { echo "REFUSED: $1 is a main repo, not a linked worktree"; exit 2; }
		[ "$(cd "$(cd "$1" && $G rev-parse --show-toplevel)" && pwd -P)" = "$(cd "$1" && pwd -P)" ] || { echo "REFUSED: $1 is not the top folder of its worktree"; exit 2; }
	}
	unlink_modules() {
		[ "$(modules "$1")" = junction ] || return 0
		rm -- "$1/node_modules"
		[ "$(modules "$1")" = none ] || { echo "REFUSED: the symlink at $1/node_modules is still there"; exit 2; }
	}
	install_own() {
		(cd "$1" && { pnpm install --frozen-lockfile --offline --silent || pnpm install --frozen-lockfile --silent; }) || { echo "FAILED: pnpm install in $1"; exit 1; }
	}
	case "$cmd" in
		add)
			REPO=$(repo_of "$1"); DIR=$2; BRANCH=$3; BASE=$4
			if [ -d "$DIR" ]; then echo "reuse $DIR"; else
				(cd "$REPO" && $G fetch -q origin && \
					if $G show-ref --verify --quiet "refs/heads/$BRANCH"; then $G worktree add -q "$DIR" "$BRANCH"; \
					elif $G show-ref --verify --quiet "refs/remotes/origin/$BRANCH"; then $G worktree add -q -b "$BRANCH" "$DIR" "origin/$BRANCH"; \
					else $G worktree add -q -b "$BRANCH" "$DIR" "$BASE"; fi)
				echo "created $DIR on $BRANCH"
			fi
			if [ "$(modules "$DIR")" = none ]; then
				if [ -f "$DIR/pnpm-lock.yaml" ]; then install_own "$DIR"; else ln -s "$REPO/node_modules" "$DIR/node_modules"; fi
			fi
			for f in .env .env.development .env.test; do [ -f "$REPO/$f" ] && [ ! -f "$DIR/$f" ] && cp "$REPO/$f" "$DIR/$f"; done
			echo "node_modules: $(modules "$DIR")"
			exit 0
			;;
		remove)
			DIR=$1
			[ -d "$DIR" ] || { echo "no such worktree: $DIR"; exit 1; }
			need_linked "$DIR"
			DIRTY=$(cd "$DIR" && $G status --porcelain | head -5)
			[ -z "$DIRTY" ] || { echo "REFUSED: $DIR has uncommitted or untracked files; nothing was removed:"; echo "$DIRTY"; exit 2; }
			if [ "$(modules "$DIR")" = junction ]; then
				echo "REFUSED: $DIR/node_modules is a symlink into the main repo. Run: wt.sh unlink $DIR, then wt.sh remove $DIR"
				exit 2
			fi
			MAIN=$(main_of "$DIR"); BEFORE=$(bin_state "$MAIN")
			[ "$(modules "$DIR")" = own ] && rm -rf -- "$DIR/node_modules"
			(cd "$MAIN" && $G worktree remove "$DIR")
			[ "$(bin_state "$MAIN")" = "$BEFORE" ] || { echo "DAMAGE: $MAIN/node_modules/.bin was $BEFORE and is now $(bin_state "$MAIN")"; exit 3; }
			echo "removed $DIR; $MAIN/node_modules/.bin $BEFORE"
			exit 0
			;;
	esac
fi
case "$cmd" in
	add)
		REPO=$(repo_of "$1"); DIR=$2; BRANCH=$3; BASE=$4
		if [ -d "$DIR" ]; then echo "reuse $DIR"; else
			(cd "$REPO" && $G fetch -q origin && \
				if $G show-ref --verify --quiet "refs/heads/$BRANCH"; then $G worktree add -q "$DIR" "$BRANCH"; \
				elif $G show-ref --verify --quiet "refs/remotes/origin/$BRANCH"; then $G worktree add -q -b "$BRANCH" "$DIR" "origin/$BRANCH"; \
				else $G worktree add -q -b "$BRANCH" "$DIR" "$BASE"; fi)
			echo "created $DIR on $BRANCH"
		fi
		if [ "$(modules "$DIR")" = none ]; then
			if [ -f "$DIR/pnpm-lock.yaml" ]; then install_own "$DIR"; else
				powershell -NoProfile -Command "New-Item -ItemType Junction -Path '$DIR/node_modules' -Target '$REPO/node_modules' | Out-Null"
			fi
		fi
		for f in .env .env.development .env.test; do [ -f "$REPO/$f" ] && [ ! -f "$DIR/$f" ] && cp "$REPO/$f" "$DIR/$f"; done
		echo "node_modules: $(modules "$DIR")"
		;;
	own)
		DIR=$1
		need_linked "$DIR"
		[ -f "$DIR/pnpm-lock.yaml" ] || { echo "REFUSED: $DIR has no pnpm-lock.yaml; an npm worktree keeps its junction"; exit 2; }
		MAIN=$(main_of "$DIR"); BEFORE=$(bin_state "$MAIN")
		unlink_modules "$DIR"
		[ "$(modules "$DIR")" = own ] || install_own "$DIR"
		[ "$(bin_state "$MAIN")" = "$BEFORE" ] || { echo "DAMAGE: $MAIN/node_modules/.bin was $BEFORE and is now $(bin_state "$MAIN")"; exit 3; }
		echo "node_modules: $(modules "$DIR"); $MAIN/node_modules/.bin $BEFORE"
		;;
	unlink)
		DIR=$1; need_linked "$DIR"; MAIN=$(main_of "$DIR"); BEFORE=$(bin_state "$MAIN")
		unlink_modules "$DIR"
		[ "$(bin_state "$MAIN")" = "$BEFORE" ] || { echo "DAMAGE: $MAIN/node_modules/.bin was $BEFORE and is now $(bin_state "$MAIN")"; exit 3; }
		echo "node_modules: $(modules "$DIR"); $MAIN/node_modules/.bin $BEFORE"
		;;
	remove)
		DIR=$1
		[ -d "$DIR" ] || { echo "no such worktree: $DIR"; exit 1; }
		need_linked "$DIR"
		DIRTY=$(cd "$DIR" && $G status --porcelain | head -5)
		[ -z "$DIRTY" ] || { echo "REFUSED: $DIR has uncommitted or untracked files; nothing was removed:"; echo "$DIRTY"; exit 2; }
		if [ "$(modules "$DIR")" = junction ]; then
			echo "REFUSED: $DIR/node_modules is a junction into the main repo. Run: wt.sh unlink $DIR, then wt.sh remove $DIR"
			exit 2
		fi
		MAIN=$(main_of "$DIR"); BEFORE=$(bin_state "$MAIN")
		# An own node_modules is full of pnpm's inner junctions; rmdir /s removes those as links, git would walk into them.
		[ "$(modules "$DIR")" = own ] && cmd //c rmdir //s //q "$(win "$DIR/node_modules")"
		(cd "$MAIN" && $G worktree remove "$DIR")
		[ "$(bin_state "$MAIN")" = "$BEFORE" ] || { echo "DAMAGE: $MAIN/node_modules/.bin was $BEFORE and is now $(bin_state "$MAIN")"; exit 3; }
		echo "removed $DIR; $MAIN/node_modules/.bin $BEFORE"
		;;
	check)
		echo "$1 node_modules: $(modules "$1")"
		;;
	*) echo "usage: wt.sh add <be|fe> <dir> <branch> <base> | own <dir> | unlink <dir> | remove <dir> | check <dir>"; exit 1;;
esac
