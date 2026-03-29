#!/bin/bash
# Safe dependency addition for agents in worktrees.
# Removes symlinked node_modules, then runs pnpm add with guard bypass.
# Usage: bash .agent/add-dep.sh <package> [--filter <workspace>]
set -e
if [ $# -eq 0 ]; then
  echo "Usage: bash .agent/add-dep.sh <package> [--filter <workspace>]"
  exit 1
fi
echo "Cleaning symlinked node_modules..."
rm -rf node_modules
for subdir in apps packages; do
  [ -d "$subdir" ] && find "$subdir" -maxdepth 2 -name node_modules -type d -exec rm -rf {} + 2>/dev/null || true
done
echo "Installing: pnpm add $@"
ORCHESTRATOR_INSTALL=1 exec pnpm add "$@"
