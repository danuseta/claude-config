#!/usr/bin/env bash
# qa-skill-sync.sh: keeps ~/.claude/skills/skill-qonflo-qa on the newest QA v2 release (DwiIndraKusuma/qonflo-qa-agent-v2).
#
#   qa-skill-sync.sh            sync now
#   qa-skill-sync.sh --daily    sync only when the last pass is older than a day (the workspace updater uses this)
#   qa-skill-sync.sh --status   print the installed release and the target; change nothing
#
# Release: the first line of ~/.claude/kit/qa-release-pin (a tag), else the newest tag matching vX.Y.Z.
# Installed: skill/skill-qonflo-qa then skill-v2/skill-qonflo-qa are copied into ~/.claude/skills/skill-qonflo-qa, in the same
# order as the v2 template (main.tf), and VERSION gets "<tag> <commit>". The same tag as VERSION names means nothing is done.
# Access is the gh login of the workspace; no token is put in a URL. A failed fetch keeps the current files and exits 0.
# Env (tests): QA_SYNC_SOURCE (a git url or path used instead of GitHub), QA_SYNC_SKILLS_DIR, QA_SYNC_CACHE, QA_SYNC_PIN_FILE, QA_SYNC_REPO.
set -uo pipefail

REPO="${QA_SYNC_REPO:-DwiIndraKusuma/qonflo-qa-agent-v2}"
SKILLS="${QA_SYNC_SKILLS_DIR:-$HOME/.claude/skills}"
CACHE="${QA_SYNC_CACHE:-$HOME/.cache/qonflo-qa-v2}"
PIN_FILE="${QA_SYNC_PIN_FILE:-$HOME/.claude/kit/qa-release-pin}"
DEST="$SKILLS/skill-qonflo-qa"
STAMP="$CACHE/last-pass"
DAILY=0 STATUS=0

for a in "$@"; do
  case "$a" in
    --daily) DAILY=1 ;;
    --status) STATUS=1 ;;
    *) echo "usage: qa-skill-sync.sh [--daily|--status]" >&2; exit 2 ;;
  esac
done

say() { printf 'qa-skill-sync: %s\n' "$*"; }

remote_git() {
  if [ -n "${QA_SYNC_SOURCE:-}" ]; then git "$@"; else git -c credential.helper= -c 'credential.helper=!gh auth git-credential' "$@"; fi
}

source_url() { if [ -n "${QA_SYNC_SOURCE:-}" ]; then printf '%s' "$QA_SYNC_SOURCE"; else printf 'https://github.com/%s.git' "$REPO"; fi; }

resolve_target() {
  local pin tags
  pin=$(head -n 1 "$PIN_FILE" 2>/dev/null | tr -d '[:space:]')
  if [ -n "$pin" ] && [ "$pin" != latest ]; then printf '%s' "$pin"; return 0; fi
  tags=$(remote_git ls-remote --tags --refs "$(source_url)" 2>/dev/null) || return 1
  printf '%s\n' "$tags" | sed -n 's#.*refs/tags/\(v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)$#\1#p' | sort -V | tail -n 1
}

fetch_tag() {
  local tag=$1 dir=$CACHE/$1
  rm -rf "$dir"
  mkdir -p "$CACHE"
  if [ -n "${QA_SYNC_SOURCE:-}" ]; then
    timeout 300 git clone -q --depth 1 --branch "$tag" "file://$(cd "$QA_SYNC_SOURCE" 2>/dev/null && pwd)" "$dir" 2>/dev/null \
      || timeout 300 git clone -q --depth 1 --branch "$tag" "$QA_SYNC_SOURCE" "$dir" 2>/dev/null || return 1
  else
    timeout 300 gh repo clone "$REPO" "$dir" -- -q --depth 1 --branch "$tag" 2>/dev/null || return 1
  fi
  [ -f "$dir/skill/skill-qonflo-qa/SKILL.md" ] && [ -f "$dir/skill-v2/skill-qonflo-qa/planner.md" ] || { say "$tag lacks the skill folders, keeping the current files"; return 1; }
  printf '%s' "$dir"
}

main() {
  local current target dir commit
  current=$(cut -d' ' -f1 "$DEST/VERSION" 2>/dev/null | head -n 1)
  if [ "$DAILY" = 1 ] && [ -f "$STAMP" ] && [ -n "$(find "$STAMP" -mmin -1380 2>/dev/null)" ]; then return 0; fi
  command -v git >/dev/null 2>&1 || { say "git is not installed, keeping the current files"; return 0; }
  if [ -z "${QA_SYNC_SOURCE:-}" ] && ! command -v gh >/dev/null 2>&1; then say "gh is not installed, keeping the current files"; return 0; fi
  target=$(resolve_target) || { say "could not list the tags of $(source_url), keeping ${current:-the current files}"; return 0; }
  [ -n "$target" ] || { say "no vX.Y.Z tag found, keeping ${current:-the current files}"; return 0; }
  if [ "$STATUS" = 1 ]; then say "installed ${current:-none}, target $target"; return 0; fi
  mkdir -p "$CACHE" && touch "$STAMP"
  if [ "$current" = "$target" ]; then say "$target already installed"; return 0; fi
  dir=$(fetch_tag "$target") || { say "fetch of $target failed, keeping ${current:-the current files}"; return 0; }
  commit=$(git -C "$dir" rev-parse --short HEAD 2>/dev/null)
  mkdir -p "$DEST"
  cp -r "$dir/skill/skill-qonflo-qa/." "$DEST/" && cp -r "$dir/skill-v2/skill-qonflo-qa/." "$DEST/" || { say "copy failed"; return 1; }
  printf '%s %s\n' "$target" "$commit" >"$DEST/VERSION"
  say "installed $target ($commit) in $DEST"
}

main
