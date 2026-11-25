#!/bin/sh
# Seed a new linked worktree with local-only files.
#
# pre-commit runs this at the post-checkout stage, which Git also invokes for
# `git worktree add`. It is a no-op in the main worktree and never overwrites
# an existing file.

[ "${PRE_COMMIT_CHECKOUT_TYPE:-0}" = "1" ] || exit 0

git_dir=$(git rev-parse --git-dir 2>/dev/null) || exit 0
common_dir=$(git rev-parse --git-common-dir 2>/dev/null) || exit 0

# Main worktree: nothing to seed.
if [ "$git_dir" = "$common_dir" ]; then
  exit 0
fi

root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
main_root=$(cd "$(dirname "$common_dir")" && pwd -P) || exit 0

if [ "$root" = "$main_root" ]; then
  exit 0
fi

created=0

link_if_missing() {
  src=$1
  dest=$2

  if [ -e "$dest" ] || [ -L "$dest" ]; then
    return 0
  fi

  if [ -e "$src" ]; then
    if ln -s "$src" "$dest"; then
      echo "worktree-init: linked $dest -> $src"
      created=1
    fi
  fi
}

copy_if_missing() {
  src=$1
  dest=$2

  if [ -e "$dest" ]; then
    return 0
  fi

  if [ -f "$src" ]; then
    if cp "$src" "$dest"; then
      echo "worktree-init: copied $dest"
      created=1
    fi
  fi
}

# Secrets and deploy inputs: one shared source, so values cannot drift.
link_if_missing "$main_root/.env" "$root/.env"
link_if_missing "$main_root/.env.keys" "$root/.env.keys"

# Build-time config: copy it so a worktree can diverge if needed.
copy_if_missing "$main_root/frontend/.env.production" "$root/frontend/.env.production"

# CloudFormation-derived values. Skip quietly when AWS or mise is unavailable.
if [ "${WORKTREE_INIT_SKIP_ENV:-0}" != "1" ] && { [ ! -f "$root/backend/.env" ] || [ ! -f "$root/frontend/.env" ]; }; then
  if command -v mise >/dev/null 2>&1; then
    if (cd "$root" && mise run env:local >/dev/null 2>&1); then
      echo "worktree-init: generated backend/.env and frontend/.env"
      created=1
    else
      echo "worktree-init: could not generate env files; run 'mise run env:local' after AWS login"
    fi
  fi
fi

if [ "$created" -eq 1 ]; then
  echo "worktree-init: run 'mise run install' in $root if dependencies are missing"
fi

exit 0
