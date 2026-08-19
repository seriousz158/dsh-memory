#!/bin/zsh

set -u
set -o pipefail
export LC_ALL=C

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || {
  print -u2 -- 'secret scan: not inside a Git repository'
  exit 2
}
cd "$repo_root" || exit 2

typeset -a tracked_files
while IFS= read -r -d '' file; do
  tracked_files+=("$file")
done < <(git ls-files -z)

if (( ${#tracked_files[@]} == 0 )); then
  print -u2 -- 'secret scan: repository has no tracked files'
  exit 2
fi

integer findings=0

# Build signatures from fragments so this scanner does not match its own rules.
slash='/'
users_prefix="${slash}Users${slash}"
home_prefix="${slash}home${slash}"
local_path_pattern="(${users_prefix}|${home_prefix})[^/[:space:]\"']+${slash}"
safe_users_example="${users_prefix}example${slash}"
safe_home_example="${home_prefix}example${slash}"
users_regex_marker="${users_prefix}["
home_regex_marker="${home_prefix}["
account_pattern='com\.zjh''macair'
private_key_pattern='-----BEGIN( [A-Z0-9]+)? PRIVATE K''EY-----'
local_metadata_pattern='\.cred''entials\.yaml|\.anonymous-user-id'
archive_pattern='\.zst''d'
credential_words='api[_-]?''key|authoriz''ation|bear''er|pass''word|secr''et'
bearer_word='bear''er'
credential_pattern="(${credential_words})[[:space:]]*[=:][[:space:]]*[\"']?[^[:space:]\"']{6,}|${bearer_word}[[:space:]]+[[:alnum:]._-]{8,}"

git_grep() {
  local source=$1
  local pattern=$2
  local output
  local grep_status
  local -a command

  command=(git grep -n -I -E -e "$pattern")
  if [[ "$source" == index ]]; then
    command+=(--cached)
  fi
  command+=(-- "${tracked_files[@]}")

  output=$(${command[@]} 2>&1)
  grep_status=$?
  if (( grep_status > 1 )); then
    print -u2 -- "secret scan: git grep failed for ${source} content"
    print -u2 -- "$output"
    exit 2
  fi
  print -r -- "$output"
  return $grep_status
}

report_unfiltered() {
  local label=$1
  local pattern=$2
  local source
  local output

  for source in working-tree index; do
    output=$(git_grep "$source" "$pattern")
    if (( $? == 0 )); then
      print -u2 -- "secret scan: ${label} found in ${source} content"
      print -u2 -- "$output"
      findings=1
    fi
  done
}

report_local_paths() {
  local source
  local output
  local hit
  local text
  local sanitized

  for source in working-tree index; do
    output=$(git_grep "$source" "$local_path_pattern")
    (( $? == 0 )) || continue
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
        print -u2 -- "secret scan: machine-specific absolute path found in ${source} content"
        print -u2 -- "$hit"
        findings=1
      fi
    done
  done
}

report_artifacts() {
  local source
  local output
  local hit
  local file

  for source in working-tree index; do
    output=$(git_grep "$source" "${local_metadata_pattern}|${archive_pattern}")
    (( $? == 0 )) || continue
    for hit in ${(f)output}; do
      file=${hit%%:*}
      case "$file" in
        .gitignore|tools/secret-scan.sh|tests/test_public_tree.sh|docs/*|README.md|SECURITY.md|CONTRIBUTING.md)
          continue
          ;;
      esac
      # Source may intentionally read compressed session inputs. Actual tracked
      # archives are rejected by the independent public-tree path guard.
      if [[ "$hit" =~ $archive_pattern ]]; then
        continue
      fi
      print -u2 -- "secret scan: local credential or generated-memory reference found in ${source} content"
      print -u2 -- "$hit"
      findings=1
    done
  done
}

credential_line_is_safe() {
  local file=$1
  local text=$2
  local lower=${(L)text}

  # Explicitly redacted documentation and environment references are not values.
  if [[ "$text" == *'[REDACTED]'* || "$text" == *'<REDACTED>'* || \
        "$text" == *'$HOME'* || "$text" == *'${'* || \
        "$lower" == *'process.env'* || "$lower" == *'os.environ'* || \
        "$lower" == *'getenv('* ]]; then
    return 0
  fi

  # Synthetic fixtures must identify themselves in the path or the value.
  local lower_file=${(L)file}
  if [[ "$file" == tests/* && \
        ( "$lower_file" == *redaction* || "$lower_file" == *secret* || \
          "$lower_file" == *security* || "$lower_file" == *fixture* || \
          "$lower" == *test* || "$lower" == *example* || \
          "$lower" == *fixture* || "$lower" == *fake* || \
          "$lower" == *dummy* ) ]]; then
    return 0
  fi

  return 1
}

report_credentials() {
  local source
  local output
  local hit
  local file
  local text

  for source in working-tree index; do
    output=$(git_grep "$source" "$credential_pattern")
    (( $? == 0 )) || continue
    for hit in ${(f)output}; do
      file=${hit%%:*}
      text=${hit#*:}
      text=${text#*:}
      if ! credential_line_is_safe "$file" "$text"; then
        print -u2 -- "secret scan: credential-like literal found in ${source} content"
        print -u2 -- "$hit"
        findings=1
      fi
    done
  done
}

report_local_paths
report_unfiltered 'user-specific account identifier' "$account_pattern"
report_unfiltered 'private-key header' "$private_key_pattern"
report_artifacts
report_credentials

if (( findings != 0 )); then
  print -u2 -- 'secret scan: FAILED'
  exit 1
fi

print -- "secret scan: passed (${#tracked_files[@]} tracked files; working tree and index checked)"
