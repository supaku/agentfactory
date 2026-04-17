#!/usr/bin/env bash
# refresh-worktree.sh — keep a git worktree rebased and its dependencies fresh.
#
# Portable, repo-agnostic. Auto-detects package manager via lockfile. Intended
# to be invoked by a Claude Code SessionStart hook (startup|clear|resume) or
# by hand. Safe to run repeatedly; no-ops unless there's work to do.
#
# Design rules:
#   - Only act inside a linked git worktree. The main checkout is never touched,
#     so the primary clone where humans do most work is protected.
#   - Never mutate anything if the working tree is dirty (skip rebase, skip deps).
#   - Never leave a broken git state: conflicting rebases are aborted.
#   - All diagnostics go to stdout so Claude sees them as session context.
#
# Configuration (all optional, via env var or .refresh-worktree.env at repo root):
#   REFRESH_UPSTREAM        Upstream to rebase onto (default: auto-detect
#                           origin/main → origin/master → origin/HEAD).
#   REFRESH_INCLUDE_MAIN    "1" to also run in the main checkout (default off).
#   REFRESH_SKIP_INSTALL    "1" to skip the dependency step entirely.
#   REFRESH_PM              Force package manager: pnpm|yarn|npm|bun (default auto).
#
# Source: https://github.com/markkropf/agent-scripts (canonical: ~/Developer/agent-scripts/worktree-refresh/lib/refresh-worktree.sh)

set -uo pipefail

REPO="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$REPO" 2>/dev/null || { echo "[refresh-worktree] cannot cd into $REPO"; exit 0; }

# Load optional per-repo overrides
if [ -f "$REPO/.refresh-worktree.env" ]; then
  # shellcheck disable=SC1091
  . "$REPO/.refresh-worktree.env"
fi

# --- Detect worktree status -------------------------------------------------
GIT_DIR="$(git rev-parse --git-dir 2>/dev/null || echo '')"
GIT_COMMON="$(git rev-parse --git-common-dir 2>/dev/null || echo '')"
if [ -z "$GIT_DIR" ] || [ -z "$GIT_COMMON" ]; then
  exit 0  # not a git repo
fi
GIT_DIR_ABS="$(cd "$GIT_DIR" && pwd)"
GIT_COMMON_ABS="$(cd "$GIT_COMMON" && pwd)"

if [ "$GIT_DIR_ABS" = "$GIT_COMMON_ABS" ] && [ "${REFRESH_INCLUDE_MAIN:-0}" != "1" ]; then
  # Main worktree — silently no-op to protect the primary checkout.
  exit 0
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'detached')"

# --- Serialize parallel invocations ----------------------------------------
LOCK_FILE="$GIT_DIR_ABS/.refresh-worktree.lock"
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK_FILE"
  flock -n 9 || { echo "[refresh-worktree] another refresh is running — skipping"; exit 0; }
fi

STATUS_LINES=()
add_status() { STATUS_LINES+=("$1"); }

# --- 1. Fetch --------------------------------------------------------------
if ! git fetch origin --quiet 2>/dev/null; then
  add_status "fetch: failed (offline?) — continuing with local state"
fi

# --- 2. Rebase -------------------------------------------------------------
UPSTREAM="${REFRESH_UPSTREAM:-}"
if [ -z "$UPSTREAM" ]; then
  for candidate in origin/main origin/master origin/HEAD; do
    if git rev-parse --verify --quiet "$candidate" >/dev/null; then
      UPSTREAM="$candidate"
      break
    fi
  done
fi

if [ -z "$UPSTREAM" ]; then
  add_status "rebase: no upstream branch resolvable"
elif [ -d "$GIT_DIR_ABS/rebase-merge" ] || [ -d "$GIT_DIR_ABS/rebase-apply" ] \
     || [ -f "$GIT_DIR_ABS/MERGE_HEAD" ] || [ -f "$GIT_DIR_ABS/CHERRY_PICK_HEAD" ]; then
  add_status "rebase: git operation in progress — skipping"
else
  DIRTY="$(git status --porcelain 2>/dev/null)"
  BEHIND="$(git rev-list --count "HEAD..$UPSTREAM" 2>/dev/null || echo 0)"

  # Don't rebase the upstream branch onto itself
  CURRENT_SHA="$(git rev-parse HEAD 2>/dev/null || echo '')"
  UPSTREAM_SHA="$(git rev-parse "$UPSTREAM" 2>/dev/null || echo '')"

  if [ "$CURRENT_SHA" = "$UPSTREAM_SHA" ]; then
    add_status "rebase: on $UPSTREAM directly — nothing to do"
  elif [ "$BEHIND" = "0" ]; then
    add_status "rebase: up-to-date with $UPSTREAM"
  elif [ -n "$DIRTY" ]; then
    add_status "rebase: $BEHIND commit(s) behind $UPSTREAM but tree is dirty — skipping"
  else
    if git rebase "$UPSTREAM" >/dev/null 2>&1; then
      add_status "rebase: rebased $BEHIND commit(s) onto $UPSTREAM"
    else
      git rebase --abort >/dev/null 2>&1 || true
      add_status "rebase: conflict against $UPSTREAM — aborted, worktree unchanged"
    fi
  fi
fi

# --- 3. Dependencies -------------------------------------------------------
if [ "${REFRESH_SKIP_INSTALL:-0}" = "1" ]; then
  add_status "deps: skipped (REFRESH_SKIP_INSTALL=1)"
else
  MARKER="$GIT_DIR_ABS/.refresh-worktree-deps-marker"

  # Detect package manager (or honor REFRESH_PM override)
  PM="${REFRESH_PM:-}"
  LOCKFILE=""
  if [ -z "$PM" ]; then
    if   [ -f pnpm-lock.yaml ]; then PM="pnpm"
    elif [ -f bun.lockb ] || [ -f bun.lock ]; then PM="bun"
    elif [ -f yarn.lock ]; then PM="yarn"
    elif [ -f package-lock.json ]; then PM="npm"
    fi
  fi

  case "$PM" in
    pnpm) LOCKFILE="pnpm-lock.yaml"; INSTALL_CMD="pnpm install --frozen-lockfile --prefer-offline" ;;
    yarn) LOCKFILE="yarn.lock";      INSTALL_CMD="yarn install --immutable" ;;
    npm)  LOCKFILE="package-lock.json"; INSTALL_CMD="npm ci --prefer-offline" ;;
    bun)  LOCKFILE="$([ -f bun.lockb ] && echo bun.lockb || echo bun.lock)"; INSTALL_CMD="bun install --frozen-lockfile" ;;
    "")   : ;;
    *)    add_status "deps: unknown REFRESH_PM='$PM' — skipping" ;;
  esac

  if [ -z "$PM" ]; then
    add_status "deps: no JS lockfile detected — skipping"
  elif [ -n "$LOCKFILE" ] && [ -n "$INSTALL_CMD" ]; then
    NEED=0
    if [ ! -f "$MARKER" ]; then NEED=1
    elif [ "$LOCKFILE" -nt "$MARKER" ]; then NEED=1
    elif [ -f package.json ] && [ package.json -nt "$MARKER" ]; then NEED=1
    fi

    if [ "$NEED" = "0" ]; then
      add_status "deps: up-to-date (no $LOCKFILE / package.json changes)"
    else
      if eval "$INSTALL_CMD" >/dev/null 2>&1; then
        touch "$MARKER"
        add_status "deps: $PM install ran"
      else
        add_status "deps: '$INSTALL_CMD' FAILED — run manually"
      fi
    fi
  fi
fi

# --- 4. Report -------------------------------------------------------------
echo "[refresh-worktree] $BRANCH"
for line in "${STATUS_LINES[@]}"; do
  echo "  - $line"
done

exit 0
