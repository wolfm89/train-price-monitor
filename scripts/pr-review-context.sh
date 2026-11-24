#!/usr/bin/env bash
# Build a self-contained review bundle for a GitHub PR.
#
# Changed files are printed exactly once, as full-context unified diffs: the complete file with
# '+'/'-' markers for added/removed lines. Untouched context, plans and evidence are printed once
# as full files. A ready-to-use review prompt is printed first.
#
# Usage: scripts/pr-review-context.sh [PR] [options]
# Run from a checkout of the PR head branch (or run `gh pr checkout <PR>` first).
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/pr-review-context.sh [PR] [options]

Build a review bundle for a GitHub PR. The PR head must be checked out.

Options:
  --pr N                 PR number (default: the current branch's PR)
  --base BRANCH          Base branch (default: the PR base; fallback main)
  --out PATH             Output file (default /tmp/pr-<N>-review-context.md)
  --focus TEXT           Extra review focus for this PR
  --context PATH         Add an untouched context file (repeatable)
  --evidence PATH        Add a generated evidence file (repeatable)
  --no-plans             Do not include .opencode/plans/*.md
  --no-auto-context      Do not add root/nearest AGENTS.md and README.md
  --prompt-only          Print only the review prompt
  --copy                 Copy the result to the clipboard when possible
  --max-context-bytes N  Skip context/plan/evidence files larger than N (default 300000)
  -h, --help             Show this help
USAGE
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

contains() {
  local needle="$1"
  shift
  local item
  for item in "$@"; do
    [[ "$item" == "$needle" ]] && return 0
  done
  return 1
}

PR=""
BASE=""
OUT=""
FOCUS=""
COPY=0
PROMPT_ONLY=0
INCLUDE_PLANS=1
AUTO_CONTEXT=1
MAX_CONTEXT_BYTES=300000
CONTEXT=()
EVIDENCE=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pr) PR="${2:?--pr needs a value}"; shift 2 ;;
    --base) BASE="${2:?--base needs a value}"; shift 2 ;;
    --out) OUT="${2:?--out needs a value}"; shift 2 ;;
    --focus) FOCUS="${2:?--focus needs a value}"; shift 2 ;;
    --context) CONTEXT+=("${2:?--context needs a value}"); shift 2 ;;
    --evidence) EVIDENCE+=("${2:?--evidence needs a value}"); shift 2 ;;
    --no-plans) INCLUDE_PLANS=0; shift ;;
    --no-auto-context) AUTO_CONTEXT=0; shift ;;
    --prompt-only) PROMPT_ONLY=1; shift ;;
    --copy) COPY=1; shift ;;
    --max-context-bytes) MAX_CONTEXT_BYTES="${2:?--max-context-bytes needs a value}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    -*) die "unknown option: $1" ;;
    *) [[ -z "$PR" ]] || die "unexpected argument: $1"; PR="$1"; shift ;;
  esac
done

command -v gh >/dev/null 2>&1 || die "gh is not installed"
command -v git >/dev/null 2>&1 || die "git is not installed"
cd "$(git rev-parse --show-toplevel)" || exit 1

if [[ -z "$PR" ]]; then
  PR="$(gh pr view --json number --jq .number 2>/dev/null)" || die "no PR for the current branch; pass --pr N"
fi
[[ "$PR" =~ ^[0-9]+$ ]] || die "PR must be a number, got: $PR"

if [[ -z "$BASE" ]]; then
  BASE="$(gh pr view "$PR" --json baseRefName --jq .baseRefName 2>/dev/null)" || BASE="main"
fi

HEAD_BRANCH="$(gh pr view "$PR" --json headRefName --jq .headRefName 2>/dev/null)" || die "cannot read PR #$PR"
CURRENT_BRANCH="$(git branch --show-current)"
[[ "$CURRENT_BRANCH" == "$HEAD_BRANCH" ]] || die "check out the PR head first: gh pr checkout $PR (current: ${CURRENT_BRANCH:-detached}, head: $HEAD_BRANCH)"

BASE_REF="$BASE"
if ! git rev-parse --verify --quiet "$BASE_REF" >/dev/null; then
  BASE_REF="origin/$BASE"
  git rev-parse --verify --quiet "$BASE_REF" >/dev/null || die "base branch not found: $BASE (try: git fetch origin $BASE)"
fi

HEAD_SHA="$(git rev-parse --short HEAD)"
BASE_SHA="$(git rev-parse --short "$BASE_REF")"
MERGE_BASE="$(git merge-base "$BASE_REF" HEAD)"
MERGE_BASE_SHORT="$(git rev-parse --short "$MERGE_BASE")"
TRACKED_DIRTY="$(git status --porcelain --untracked-files=no)"
[[ -z "$TRACKED_DIRTY" ]] || printf 'warning: tracked files have uncommitted changes; the diff is merge-base..HEAD and context files read the working tree\n' >&2

NAME_STATUS="$(git diff --name-status --find-renames "$BASE_REF...HEAD")"
NUMSTAT="$(git diff --numstat --find-renames "$BASE_REF...HEAD")"

CHANGED=()
while IFS= read -r file; do
  [[ -n "$file" ]] && CHANGED+=("$file")
done < <(git diff --name-only --find-renames "$BASE_REF...HEAD")
[[ ${#CHANGED[@]} -gt 0 ]] || die "the PR has no changed files; is the head checked out?"

DELETED=()
BINARY=()
while IFS=$'\t' read -r added removed path; do
  [[ -z "${path:-}" ]] && continue
  [[ "$added" == "-" ]] && BINARY+=("$path")
done <<< "$NUMSTAT"
while IFS= read -r file; do
  [[ -n "$file" ]] && DELETED+=("$file")
done < <(git diff --name-only --diff-filter=D --find-renames "$BASE_REF...HEAD")

CONTEXT_LIST=()
PLAN_LIST=()
EVIDENCE_LIST=()
SEEN=()

add_context() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  contains "$file" "${CHANGED[@]}" && return 0
  contains "$file" "${CONTEXT_LIST[@]}" && return 0
  CONTEXT_LIST+=("$file")
}

add_plan() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  contains "$file" "${CHANGED[@]}" && return 0
  contains "$file" "${PLAN_LIST[@]}" && return 0
  PLAN_LIST+=("$file")
}

add_evidence() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  contains "$file" "${CHANGED[@]}" && return 0
  contains "$file" "${EVIDENCE_LIST[@]}" && return 0
  EVIDENCE_LIST+=("$file")
}

if (( AUTO_CONTEXT )); then
  for file in AGENTS.md README.md CONTRIBUTING.md SECURITY.md; do add_context "$file"; done
  for file in "${CHANGED[@]}"; do
    dir="$(dirname "$file")"
    while [[ "$dir" != "." && "$dir" != "/" ]]; do
      add_context "$dir/AGENTS.md"
      add_context "$dir/README.md"
      dir="$(dirname "$dir")"
    done
  done
fi
for file in "${CONTEXT[@]}"; do add_context "$file"; done

if (( INCLUDE_PLANS )) && [[ -d .opencode/plans ]]; then
  while IFS= read -r file; do add_plan "$file"; done < <(find .opencode/plans -maxdepth 1 -type f -name '*.md' | sort)
fi
for file in "${EVIDENCE[@]}"; do add_evidence "$file"; done

has_prefix() {
  local prefix="$1"
  local file
  for file in "${CHANGED[@]}"; do
    [[ "$file" == "$prefix"* ]] && return 0
  done
  return 1
}

build_prompt() {
  cat <<EOF
## Review prompt

You are a senior reviewer for PR #$PR in this repository. The PR targets \`$BASE\`; this bundle
was built at \`$HEAD_SHA\` from merge base \`$MERGE_BASE_SHORT\`.

Read in this order:

1. **File map** — every changed file with status (M/A/D/R) and added/deleted line counts, plus
   the untouched context, plans and evidence included below.
2. **Changed files** — each changed file appears **once**, as a full-file unified diff: a leading
   \`+\` is an added line, \`-\` a removed line, and a leading space is unchanged context. The \`@@\`
   header gives the line ranges. Because the diff carries full context, the entire file is present;
   there is no separate full-file copy.
3. **Untouched context** — full files that define contracts the PR relies on; they are not changed.
4. **Plans** — intent and history when included; **evidence** — generated outputs, not code.
5. The PR description is a claim, not proof. Verify it against the code and tests.

Focus on:

- correctness and regressions in the changed behavior;
- security, privacy, secret handling and data exposure;
- data/ML leakage, evaluation discipline and reproducibility where relevant;
- test gaps and edge cases the tests would miss;
- configuration, docs and generated artifacts staying consistent with the code;
- performance or cost regressions.

Skip style nits that a formatter already covers.

For each finding, give:

- severity: critical / should-fix / nice-to-have;
- file:line;
- why it is wrong (the failure mode);
- a concrete fix or test.

Verify claims against the code or a small command; mark anything you could not verify. Do not
modify the repository. If an area is fine, say so with the evidence you checked.
EOF
  if (( AUTO_CONTEXT )) && contains "AGENTS.md" "${CONTEXT_LIST[@]}"; then
    printf '\nThe repository `AGENTS.md` files are included; follow their guardrails.\n'
  fi
  local auto_focus=()
  has_prefix "analytics/" && auto_focus+=("analytics: label and feature leakage, evaluation discipline, reproducibility, calibration and threshold signs")
  has_prefix "frontend/" && auto_focus+=("frontend: accessibility, state, API contracts, rendering regressions")
  has_prefix "backend/" && auto_focus+=("backend: authentication, authorisation, privacy, GraphQL contracts, SQS/Lambda behaviour")
  has_prefix "scraper/" && auto_focus+=("scraper: transport, retries, schedule, privacy, Parquet schema")
  has_prefix "infrastructure/" && auto_focus+=("infrastructure: CDK diff, IAM, alarms, cost ceiling, deploy safety")
  if [[ ${#auto_focus[@]} -gt 0 ]]; then
    printf '\nRepository-specific focus for the touched areas:\n\n'
    for item in "${auto_focus[@]}"; do printf -- '- %s\n' "$item"; done
  fi
  if [[ -n "$FOCUS" ]]; then
    printf '\nAdditional focus requested by the author: %s\n' "$FOCUS"
  fi
}

emit_full() {
  local file="$1"
  local kind="$2"
  local max_bytes="$3"
  [[ -f "$file" ]] || return 0
  contains "$file" "${SEEN[@]}" && return 0
  SEEN+=("$file")
  local bytes lines
  bytes="$(wc -c < "$file")"
  lines="$(wc -l < "$file")"
  printf '\n### %s: `%s`\n\n' "$kind" "$file"
  printf '_%s bytes, %s lines._\n\n' "$bytes" "$lines"
  if (( bytes > max_bytes )); then
    printf '_Skipped: larger than --max-context-bytes (%s > %s). Read it from the checkout if needed._\n' "$bytes" "$max_bytes"
    return 0
  fi
  printf '````text\n'
  cat "$file"
  printf '\n````\n'
}

emit_diff() {
  local file="$1"
  contains "$file" "${SEEN[@]}" && return 0
  SEEN+=("$file")
  printf '\n### Changed file: `%s`\n\n' "$file"
  if contains "$file" "${BINARY[@]}"; then
    printf '_Binary file; the full-context diff is omitted. See the file map._\n'
    return 0
  fi
  local tmp
  tmp="$(mktemp)"
  git diff --unified=1000000 --no-color --no-ext-diff --find-renames "$BASE_REF...HEAD" -- "$file" > "$tmp"
  if ! grep -q '^@@' "$tmp"; then
    if [[ -s "$tmp" ]]; then
      printf '_Metadata-only change (for example a pure rename):_\n\n'
      awk 'BEGIN { header=1 } header && /^@@/ { header=0 } header && /^diff --git / { next } header && /^index / { next } header && /^--- / { next } header && /^+++ / { next } { print }' "$tmp"
      printf '\n'
    fi
    if [[ -f "$file" ]]; then
      printf '_No content hunk; full current file follows._\n\n'
      printf '````text\n'
      cat "$file"
      printf '\n````\n'
    else
      printf '_Deleted file; the old content is shown above._\n'
    fi
    rm -f "$tmp"
    return 0
  fi
  printf '_Full-context unified diff: `+` added, `-` removed, leading space unchanged; `@@` gives ranges._\n\n'
  printf '````diff\n'
  awk 'BEGIN { header=1 } header && /^@@/ { header=0 } header && /^diff --git / { next } header && /^index / { next } header && /^--- / { next } header && /^+++ / { next } { print }' "$tmp"
  printf '\n````\n'
  rm -f "$tmp"
}

if [[ -z "$OUT" ]]; then
  OUT="/tmp/pr-${PR}-review-context.md"
fi
mkdir -p "$(dirname "$OUT")"

if (( PROMPT_ONLY )); then
  build_prompt > "$OUT"
else
  {
    printf '# PR review context — #%s\n\n' "$PR"
    build_prompt
    printf '\n## PR description\n\n'
    gh pr view "$PR" --json title,body,url,state,author --jq \
      '"### " + .title + "\n\nState: " + .state + " | Author: " + .author.login + "\n" + .url + "\n\n" + (.body // "")'
    printf '\n## Provenance\n\n'
    printf -- '- Base: `%s` at `%s`\n' "$BASE" "$BASE_SHA"
    printf -- '- Head: `%s` at `%s`\n' "$HEAD_BRANCH" "$HEAD_SHA"
    printf -- '- Merge base: `%s`\n' "$MERGE_BASE_SHORT"
    printf -- '- Diff command: `git diff --find-renames %s...HEAD`\n' "$BASE_REF"
    printf -- '- Working tree: %s\n' "$([[ -z "$TRACKED_DIRTY" ]] && echo clean || echo 'dirty (tracked changes uncommitted; diff is merge-base..HEAD)')"
    printf '\n## File map\n\n'
    printf 'Changed by the PR (status, added/deleted lines, path):\n\n'
    while IFS=$'\t' read -r status rest; do
      [[ -z "${rest:-}" ]] && continue
      counts="$(awk -F '\t' -v p="$rest" '$3 == p { printf "+%s/-%s", $1, $2; found=1 } END { if (!found) printf "-" }' <<< "$NUMSTAT")"
      printf -- '- `%s` %s %s\n' "$(printf '%s' "$status" | cut -c1-1)" "$counts" "$rest"
    done <<< "$NAME_STATUS"
    printf '\nUntouched context (full files below):\n\n'
    if [[ ${#CONTEXT_LIST[@]} -eq 0 ]]; then printf -- '- none\n'; else printf -- '- `%s`\n' "${CONTEXT_LIST[@]}"; fi
    printf '\nPlans (full files below):\n\n'
    if [[ ${#PLAN_LIST[@]} -eq 0 ]]; then printf -- '- none\n'; else printf -- '- `%s`\n' "${PLAN_LIST[@]}"; fi
    printf '\nEvidence (full files below):\n\n'
    if [[ ${#EVIDENCE_LIST[@]} -eq 0 ]]; then printf -- '- none\n'; else printf -- '- `%s`\n' "${EVIDENCE_LIST[@]}"; fi
    printf '\n## Changed files\n\n'
    printf 'Each changed file appears once as a full-context diff; the whole file is present.\n'
    for file in "${CHANGED[@]}"; do emit_diff "$file"; done
    printf '\n## Untouched context\n'
    for file in "${CONTEXT_LIST[@]}"; do emit_full "$file" "context" "$MAX_CONTEXT_BYTES"; done
    printf '\n## Plans\n'
    for file in "${PLAN_LIST[@]}"; do emit_full "$file" "plan" "$MAX_CONTEXT_BYTES"; done
    printf '\n## Evidence\n'
    for file in "${EVIDENCE_LIST[@]}"; do emit_full "$file" "evidence" "$MAX_CONTEXT_BYTES"; done
    printf '\n## Deleted files\n\n'
    if [[ ${#DELETED[@]} -eq 0 ]]; then printf -- '- none\n'; else printf -- '- `%s`\n' "${DELETED[@]}"; fi
  } > "$OUT"
fi

bytes="$(wc -c < "$OUT")"
lines="$(wc -l < "$OUT")"
printf 'wrote %s (%s lines, %s bytes, roughly %s tokens)\n' "$OUT" "$lines" "$bytes" "$((bytes / 4))"

if (( COPY )); then
  if command -v clip.exe >/dev/null 2>&1; then
    clip.exe < "$OUT"
    printf 'copied with clip.exe\n'
  elif command -v wl-copy >/dev/null 2>&1; then
    wl-copy < "$OUT"
    printf 'copied with wl-copy\n'
  elif command -v xclip >/dev/null 2>&1; then
    xclip -selection clipboard < "$OUT"
    printf 'copied with xclip\n'
  else
    printf 'no clipboard tool found; the file is at %s\n' "$OUT"
  fi
fi
