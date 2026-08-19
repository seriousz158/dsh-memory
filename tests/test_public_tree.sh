#!/bin/zsh

set -u
set -o pipefail
export LC_ALL=C

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || {
  print -u2 -- 'public tree check: not inside a Git repository'
  exit 2
}
cd "$repo_root" || exit 2

typeset -a tracked_files
while IFS= read -r -d '' file; do
  tracked_files+=("$file")
done < <(git ls-files -z)

if (( ${#tracked_files[@]} == 0 )); then
  print -u2 -- 'public tree check: repository has no tracked files'
  exit 2
fi

integer findings=0

for file in "${tracked_files[@]}"; do
  case "$file" in
    .gitignore|CHANGELOG.md|CONTRIBUTING.md|LICENSE|README.md|SECURITY.md|package.json|package-lock.json)
      ;;
    .github/*|docs/*|examples/*|integrations/*|packages/*|tests/*|tools/*)
      ;;
    *)
      print -u2 -- "public tree check: path is outside the publication allowlist: $file"
      findings=1
      ;;
  esac

  case "/$file/" in
    */.dsh/*|*/sessions/*|*/storages/*|*/node_modules/*|*/.playwright-cli/*|*/__pycache__/*)
      print -u2 -- "public tree check: forbidden tracked path: $file"
      findings=1
      ;;
  esac

  case "$file" in
    *.zstd|*.pyc|*.pyo|*.log|*.DS_Store)
      print -u2 -- "public tree check: generated artifact is tracked: $file"
      findings=1
      ;;
  esac
done

slash='/'
users_prefix="${slash}Users${slash}"
home_prefix="${slash}home${slash}"
local_path_pattern="(${users_prefix}|${home_prefix})[^/[:space:]\"']+${slash}"
safe_users_example="${users_prefix}example${slash}"
safe_home_example="${home_prefix}example${slash}"
users_regex_marker="${users_prefix}["
home_regex_marker="${home_prefix}["

check_content_paths() {
  local source=$1
  local output
  local grep_status
  local hit
  local text
  local sanitized
  local -a command

  command=(git grep -n -I -E -e "$local_path_pattern")
  if [[ "$source" == index ]]; then
    command+=(--cached)
  fi
  command+=(-- "${tracked_files[@]}")

  output=$(${command[@]} 2>&1)
  grep_status=$?
  if (( grep_status > 1 )); then
    print -u2 -- "public tree check: git grep failed for ${source} content"
    print -u2 -- "$output"
    exit 2
  fi
  (( grep_status == 0 )) || return 0

  for hit in ${(f)output}; do
    text=${hit#*:}
    text=${text#*:}
    sanitized=${text//$safe_users_example/\$HOME/}
    sanitized=${sanitized//$safe_home_example/\$HOME/}
    if [[ "$sanitized" == *"$users_regex_marker"* || \
          "$sanitized" == *"$home_regex_marker"* ]]; then
      continue
    fi
    if [[ "$sanitized" =~ $local_path_pattern ]]; then
      print -u2 -- "public tree check: source-checkout absolute path in ${source} content"
      print -u2 -- "$hit"
      findings=1
    fi
  done
}

check_content_paths working-tree
check_content_paths index

if (( findings != 0 )); then
  print -u2 -- 'public tree check: FAILED'
  exit 1
fi

print -- "public tree check: passed (${#tracked_files[@]} allowlisted tracked files)"
