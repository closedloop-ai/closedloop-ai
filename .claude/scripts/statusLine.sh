#!/bin/bash
# Claude Code status line script
# Reads JSON from stdin and prints ONE line to stdout.

set -euo pipefail

input="$(cat || true)"
if [ -z "${input}" ]; then
  input="{}"
fi

# One jq call for speed (statusline updates can run frequently).  [oai_citation:1‡Claude Code](https://code.claude.com/docs/en/statusline?utm_source=chatgpt.com)
IFS=$'\t' read -r MODEL CURRENT_DIR CONTEXT_SIZE IN_TOKENS OUT_TOKENS CACHE_CREATE CACHE_READ <<EOF
$(echo "$input" | jq -r '[
  (.model.display_name // "unknown"),
  (.workspace.current_dir // ""),
  (.context_window.context_window_size // 0),
  (.context_window.current_usage.input_tokens // 0),
  (.context_window.current_usage.output_tokens // 0),
  (.context_window.current_usage.cache_creation_input_tokens // 0),
  (.context_window.current_usage.cache_read_input_tokens // 0)
] | @tsv')
EOF

# Directory display (match docs style: show the last path component)  [oai_citation:2‡Claude Code](https://code.claude.com/docs/en/statusline?utm_source=chatgpt.com)
# Note I'm not using this currently but you could use it below if you wanted
DIR_BASENAME="${CURRENT_DIR##*/}"
if [ -z "$DIR_BASENAME" ]; then
  DIR_BASENAME="."
fi

# Total usage: include cache tokens (recommended / shown in schema)  [oai_citation:3‡Claude Code](https://code.claude.com/docs/en/statusline?utm_source=chatgpt.com)
TOTAL_TOKENS=$(( IN_TOKENS + OUT_TOKENS + CACHE_CREATE + CACHE_READ ))

PERCENT_USED=0
if [ "${CONTEXT_SIZE}" -gt 0 ] && [ "${TOTAL_TOKENS}" -gt 0 ]; then
  PERCENT_USED=$(( TOTAL_TOKENS * 100 / CONTEXT_SIZE ))
fi

# Git branch (fast + quiet)
GIT_BRANCH=""
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  BRANCH="$(git symbolic-ref --short -q HEAD 2>/dev/null || true)"
  if [ -n "$BRANCH" ]; then
    GIT_BRANCH="$BRANCH"
  fi
fi

# Output: first line of stdout becomes the status line.  [oai_citation:4‡Claude Code](https://code.claude.com/docs/en/statusline?utm_source=chatgpt.com)
echo "[$MODEL] $GIT_BRANCH | Context: ${PERCENT_USED}%"
