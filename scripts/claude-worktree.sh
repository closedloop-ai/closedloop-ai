#!/usr/bin/env bash
set -euo pipefail

# Launch Claude Code in a git worktree with full environment setup.
#
# Usage:
#   ./scripts/claude-worktree.sh <name> [claude args...]
#
# Examples:
#   ./scripts/claude-worktree.sh my-feature
#   ./scripts/claude-worktree.sh my-feature -p "fix the login bug"
#   ./scripts/claude-worktree.sh my-feature --model sonnet

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORKTREE_DIR="$REPO_ROOT/.closedloop-ai/worktrees"

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <worktree-name> [claude args...]"
  echo ""
  echo "Creates a git worktree, symlinks env files, installs deps,"
  echo "generates Prisma client, and launches Claude Code."
  exit 1
fi

WORKTREE_NAME="$1"
shift
CLAUDE_ARGS=("$@")

TARGET="$WORKTREE_DIR/$WORKTREE_NAME"

# --- Create worktree if it doesn't exist ---
if [[ -d "$TARGET" ]]; then
  echo "Worktree '$WORKTREE_NAME' already exists at $TARGET"
else
  echo "Creating worktree '$WORKTREE_NAME' from HEAD..."
  mkdir -p "$WORKTREE_DIR"
  BRANCH_NAME="worktree-$WORKTREE_NAME"

  # Create a new branch for the worktree based on current HEAD
  git -C "$REPO_ROOT" worktree add -b "$BRANCH_NAME" "$TARGET" HEAD 2>/dev/null \
    || git -C "$REPO_ROOT" worktree add "$TARGET" "$BRANCH_NAME" \
    || { echo "Error: Could not create worktree. Branch '$BRANCH_NAME' may already exist on a different commit."; exit 1; }

  echo "Worktree created at $TARGET"
fi

# --- Symlink env files ---
echo "Symlinking environment files..."
find "$REPO_ROOT" -maxdepth 4 \
  -path "$REPO_ROOT/node_modules" -prune -o \
  -path "$REPO_ROOT/.closedloop-ai" -prune -o \
  -path "$REPO_ROOT/.claude" -prune -o \
  \( -name ".env" -o -name ".env.local" \) -type f -print0 \
  | while IFS= read -r -d '' src; do
    rel="${src#"$REPO_ROOT"/}"
    dst="$TARGET/$rel"
    mkdir -p "$(dirname "$dst")"
    ln -sf "$src" "$dst"
    echo "  $rel -> symlinked"
  done

# --- Install dependencies ---
echo "Installing dependencies (pnpm install)..."
(cd "$TARGET" && pnpm install --frozen-lockfile 2>&1) || {
  echo "pnpm install --frozen-lockfile failed, trying without frozen lockfile..."
  (cd "$TARGET" && pnpm install 2>&1)
}

# --- Generate Prisma client ---
echo "Generating Prisma client..."
(cd "$TARGET/packages/database" && pnpm prisma generate 2>&1)

echo ""
echo "Worktree ready at: $TARGET"
echo "Launching Claude Code..."
echo ""

# --- Launch Claude Code in the worktree ---
cd "$TARGET"
exec claude "${CLAUDE_ARGS[@]+"${CLAUDE_ARGS[@]}"}"
