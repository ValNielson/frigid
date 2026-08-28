#!/usr/bin/env bash
set -euo pipefail

input=$(cat)
project_dir=$(printf '%s' "$input" | jq -r '.cwd // empty')
[ -n "$project_dir" ] || project_dir=$PWD
root=$(git -C "$project_dir" rev-parse --show-toplevel 2>/dev/null) || exit 0

fingerprint_file="$root/.claude/.hackathon-fingerprint"
fingerprint=$( { git -C "$root" rev-parse HEAD 2>/dev/null || echo no-head
                 git -C "$root" status --porcelain
                 git -C "$root" diff --stat HEAD 2>/dev/null; } | shasum | cut -d' ' -f1)

if [ "$(printf '%s' "$input" | jq -r '.stop_hook_active // false')" = "true" ]; then
  printf '%s\n' "$fingerprint" > "$fingerprint_file"
  exit 0
fi

[ -f "$fingerprint_file" ] && [ "$(cat "$fingerprint_file")" = "$fingerprint" ] && exit 0

printf '%s\n' "$fingerprint" > "$fingerprint_file"
jq -n '{decision: "block", reason: "The repository changed since the hackathon build log was last checked. Invoke the convex-hackathon-skill skill now to update hackathon.md, then stop. If the skill finds no new evidence, say the log is already current and stop."}'
