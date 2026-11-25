#!/bin/sh
# Seed a new linked worktree with local-only files.
#
# pre-commit runs this at the post-checkout stage, which Git also invokes for
# `git worktree add`. It is a no-op in the main worktree. Existing files are
# left alone; env:local only runs when both generated env files are missing.

[ "${PRE_COMMIT_CHECKOUT_TYPE:-0}" = "1" ] || exit 0

git_dir=$(git rev-parse --git-dir 2>/dev/null) || exit 0
common_dir=$(git rev-parse --git-common-dir 2>/dev/null) || exit 0

# Main worktree: nothing to seed.
if [ "$git_dir" = "$common_dir" ]; then
  exit 0
fi

root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
main_root=$(git worktree list --porcelain | sed -n '1s/^worktree //p')
[ -n "$main_root" ] || exit 0

if [ "$root" = "$main_root" ]; then
  exit 0
fi

created=0

clear_dangling_symlink() {
  dest=$1

  if [ -L "$dest" ] && [ ! -e "$dest" ]; then
    rm -f "$dest"
  fi
}

link_if_missing() {
  src=$1
  dest=$2

  clear_dangling_symlink "$dest"
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

  clear_dangling_symlink "$dest"
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

# `.env` is loaded by mise. `.env.keys` is a manual provider-key stash for
# transport experiments; nothing in the repo loads it automatically.
link_if_missing "$main_root/.env" "$root/.env"
link_if_missing "$main_root/.env.keys" "$root/.env.keys"

# Build-time config: copy it so a worktree can diverge if needed.
copy_if_missing "$main_root/frontend/.env.production" "$root/frontend/.env.production"

# `git worktree add` reports an all-zero from-ref; a branch checkout does not.
# Only a new worktree may call AWS, and only when both generated files are absent,
# so a checkout never overwrites hand-edited env files.
is_new_worktree=0
case "${PRE_COMMIT_FROM_REF:-}" in
  0000000000000000000000000000000000000000) is_new_worktree=1 ;;
esac

if [ "${WORKTREE_INIT_SKIP_ENV:-0}" != "1" ] &&
  [ "$is_new_worktree" -eq 1 ] &&
  [ ! -f "$root/backend/.env" ] &&
  [ ! -f "$root/frontend/.env" ]; then
  if command -v mise >/dev/null 2>&1; then
    if (cd "$root" && mise run env:local >/dev/null 2>&1); then
      echo "worktree-init: generated backend/.env, frontend/.env and frontend/.env.production"
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
