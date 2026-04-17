#!/usr/bin/env bash
# Create a git worktree at ../agentfactory.wt/<name> for isolated Claude sessions.
#
# Usage (standalone):
#   ./scripts/create-worktree.sh <name>
#
# Creates the worktree if it doesn't exist, copies env files, and prints the path.
# Handles stale git worktree metadata from previously rm -rf'd directories.

set -euo pipefail

WT_NAME="${1:?Usage: create-worktree.sh <name>}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WT_ROOT="$(dirname "$REPO_ROOT")/agentfactory.wt"
WT_PATH="$WT_ROOT/$WT_NAME"
BRANCH="worktree-${WT_NAME}"

mkdir -p "$WT_ROOT"

# If the worktree directory already exists AND git knows about it, reuse it
if [ -d "$WT_PATH" ] && git -C "$REPO_ROOT" worktree list 2>/dev/null | grep -q "$WT_PATH"; then
  echo "$WT_PATH"
  exit 0
fi

# Clean up ALL stale state for this name:
# - Our target directory
# - Default .claude/worktrees/ directory (left by claude -w)
# - Stale git worktree metadata
# - Stale branch
if [ -d "$WT_PATH" ]; then
  git -C "$REPO_ROOT" worktree remove "$WT_PATH" --force >/dev/null 2>&1 || rm -rf "$WT_PATH"
fi
if [ -d "$REPO_ROOT/.claude/worktrees/$WT_NAME" ]; then
  git -C "$REPO_ROOT" worktree remove "$REPO_ROOT/.claude/worktrees/$WT_NAME" --force >/dev/null 2>&1 || rm -rf "$REPO_ROOT/.claude/worktrees/$WT_NAME"
fi
git -C "$REPO_ROOT" worktree prune >/dev/null 2>&1 || true
git -C "$REPO_ROOT" branch -D "$BRANCH" >/dev/null 2>&1 || true

# Fetch latest from origin
git -C "$REPO_ROOT" fetch origin --quiet 2>/dev/null || true

# Create the worktree with a new branch from origin/HEAD
git -C "$REPO_ROOT" worktree add "$WT_PATH" -b "$BRANCH" origin/HEAD >/dev/null 2>&1 || {
  echo "Failed to create worktree at $WT_PATH" >&2
  exit 1
}

# Copy dev config files into the worktree
for f in .env.local .env; do
  if [ -f "$REPO_ROOT/$f" ]; then
    cp "$REPO_ROOT/$f" "$WT_PATH/$f"
  fi
done

# Install dependencies
echo "Installing dependencies in $WT_PATH..." >&2
(cd "$WT_PATH" && pnpm install --frozen-lockfile --prefer-offline) >&2
(cd "$WT_PATH" && touch "$(git rev-parse --git-dir)/.refresh-worktree-deps-marker") 2>/dev/null || true

echo "$WT_PATH"
