#!/usr/bin/env zsh
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "$0")/.." && pwd -P)"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/dsh-memory-release-guards.XXXXXX")"

copy_guard_sources() {
  local fixture="$1"
  mkdir -p "$fixture/tools" "$fixture/tests"
  cp "$PROJECT_DIR/tools/secret-scan.sh" "$fixture/tools/secret-scan.sh"
  cp "$PROJECT_DIR/tests/test_public_tree.sh" "$fixture/tests/test_public_tree.sh"
  [[ ! -f "$PROJECT_DIR/tools/secret-scan.mjs" ]] || cp "$PROJECT_DIR/tools/secret-scan.mjs" "$fixture/tools/secret-scan.mjs"
  [[ ! -f "$PROJECT_DIR/tools/public-tree-check.mjs" ]] || cp "$PROJECT_DIR/tools/public-tree-check.mjs" "$fixture/tools/public-tree-check.mjs"
  chmod +x "$fixture/tools/secret-scan.sh" "$fixture/tests/test_public_tree.sh"
}

make_fixture() {
  local name="$1"
  local fixture="$TEST_ROOT/$name"
  mkdir -p "$fixture"
  git -C "$PROJECT_DIR" archive "$(git -C "$PROJECT_DIR" write-tree)" | tar -x -C "$fixture"
  copy_guard_sources "$fixture"
  git -C "$fixture" init --quiet
  git -C "$fixture" config user.name "DSH Memory Guard Test"
  git -C "$fixture" config user.email "guard-test@example.invalid"
  git -C "$fixture" add .
  git -C "$fixture" commit --quiet -m baseline
  print -- "$fixture"
}

expect_secret_failure() {
  local fixture="$1"
  local label="$2"
  local output
  if output="$(cd "$fixture" && zsh tools/secret-scan.sh 2>&1)"; then
    print -u2 -- "secret scanner unexpectedly accepted $label"
    exit 1
  fi
  [[ "$output" == *"secret scan: FAILED"* ]] || {
    print -u2 -- "secret scanner did not report a fail-closed result for $label"
    exit 1
  }
}

expect_secret_success() {
  local fixture="$1"
  local label="$2"
  local output
  if ! output="$(cd "$fixture" && zsh tools/secret-scan.sh 2>&1)"; then
    print -u2 -- "secret scanner unexpectedly rejected $label"
    print -u2 -- "$output"
    exit 1
  fi
}

expect_public_tree_failure() {
  local fixture="$1"
  local label="$2"
  local output
  if output="$(cd "$fixture" && zsh tests/test_public_tree.sh 2>&1)"; then
    print -u2 -- "public tree check unexpectedly accepted $label"
    exit 1
  fi
  [[ "$output" == *"public tree check: FAILED"* ]] || {
    print -u2 -- "public tree check did not report a fail-closed result for $label"
    exit 1
  }
}

expect_workspace_license() {
  local workspace="$1"
  local output
  output="$(cd "$PROJECT_DIR" && npm pack --dry-run --json --ignore-scripts --workspace "$workspace")"
  node - "$workspace" "$output" <<'NODE'
const workspace = process.argv[2];
const packed = JSON.parse(process.argv[3]);
const files = packed.flatMap((item) => item.files ?? []).map((entry) => entry.path);
if (!files.includes("LICENSE")) {
  console.error(`${workspace} package is missing LICENSE`);
  process.exit(1);
}
NODE
}

expect_workspace_license dsh-memory
expect_workspace_license dsh-memory-ui

fixture="$(make_fixture untracked-npmrc)"
prefix="ghp"
suffix="abcdef0123456789abcdef0123456789abcdef"
print -- "_authToken=${prefix}_${suffix}" > "$fixture/.npmrc"
expect_secret_failure "$fixture" "an untracked npm credential file"
expect_public_tree_failure "$fixture" "an untracked npm credential file"

fixture="$(make_fixture staged-npmrc)"
print -- "_authToken=${prefix}_${suffix}" > "$fixture/.npmrc"
git -C "$fixture" add .npmrc
expect_secret_failure "$fixture" "a staged npm credential file"
expect_public_tree_failure "$fixture" "a staged npm credential file"

fixture="$(make_fixture staged-key)"
provider_prefix="sk"
provider_suffix="release-guard-synthetic-value"
print -- "const providerKey = '${provider_prefix}-${provider_suffix}';" >> "$fixture/packages/dsh-memory/lib/index.js"
print -- "const redacted = '[REDACTED]';" >> "$fixture/packages/dsh-memory/lib/index.js"
git -C "$fixture" add packages/dsh-memory/lib/index.js
expect_secret_failure "$fixture" "a staged key hidden beside a redaction marker"

fixture="$(make_fixture private-path)"
slash="/"
print -- "const leakedPath = '${slash}root${slash}private-memory';" >> "$fixture/packages/dsh-memory/lib/index.js"
git -C "$fixture" add packages/dsh-memory/lib/index.js
expect_secret_failure "$fixture" "a staged private root path"

fixture="$(make_fixture bare-yaml-credential)"
password_field="pass""word"
password_value="hunter2""secret"
print -- "${password_field}: ${password_value}" >> "$fixture/examples/dsh/settings.yaml.example"
git -C "$fixture" add examples/dsh/settings.yaml.example
expect_secret_failure "$fixture" "a bare YAML password assignment"

for composite_field in client_secret access_token refresh_token auth_token private_key; do
  fixture="$(make_fixture "bare-yaml-${composite_field}")"
  composite_value="synthetic${composite_field//_/}credential123"
  print -- "${composite_field}: ${composite_value}" >> "$fixture/examples/dsh/settings.yaml.example"
  git -C "$fixture" add examples/dsh/settings.yaml.example
  expect_secret_failure "$fixture" "a bare YAML ${composite_field} assignment"
done

fixture="$(make_fixture compound-yaml-credential)"
safe_field="to""ken"
compound_field="client_""secret"
compound_value="abcdefghijkl""mnop"
print -- "const credentials = { ${safe_field}: process.env.SAFE_TOKEN, ${compound_field}: \"${compound_value}\" };" >> "$fixture/packages/dsh-memory/lib/index.js"
git -C "$fixture" add packages/dsh-memory/lib/index.js
expect_secret_failure "$fixture" "a literal credential following an environment reference on one line"

fixture="$(make_fixture compound-redacted-credential)"
safe_field="to""ken"
compound_field="private_""key"
compound_value="abcdefghijkl""mnop"
print -- "const credentials = { ${safe_field}: [REDACTED], ${compound_field}: \"${compound_value}\" };" >> "$fixture/packages/dsh-memory/lib/index.js"
git -C "$fixture" add packages/dsh-memory/lib/index.js
expect_secret_failure "$fixture" "a literal credential following a redaction marker on one line"

fixture="$(make_fixture multiline-index-credential)"
multiline_field="client_""secret"
multiline_value="abcdefghijkl""mnop"
printf '\nconst %s =\n  "%s";\n' "$multiline_field" "$multiline_value" >> "$fixture/packages/dsh-memory/lib/index.js"
git -C "$fixture" add packages/dsh-memory/lib/index.js
git -C "$fixture" show HEAD:packages/dsh-memory/lib/index.js > "$fixture/packages/dsh-memory/lib/index.js"
expect_secret_failure "$fixture" "an index-only multiline literal credential assignment"

fixture="$(make_fixture typed-index-credential)"
typed_field="client_""secret"
typed_value="abcdefghijkl""mnop"
print -- "${typed_field}: str = \"${typed_value}\"" >> "$fixture/packages/dsh-memory/lib/safe-clear.py"
git -C "$fixture" add packages/dsh-memory/lib/safe-clear.py
git -C "$fixture" show HEAD:packages/dsh-memory/lib/safe-clear.py > "$fixture/packages/dsh-memory/lib/safe-clear.py"
expect_secret_failure "$fixture" "an index-only typed literal credential assignment"

fixture="$(make_fixture bracket-comment-index-credential)"
bracket_field="client_""secret"
bracket_value="abcdefghijkl""mnop"
print -- "const credentials = {}; credentials[\"${bracket_field}\"] = \"${bracket_value}\"; const commented = { ${bracket_field} /* comment */: \"${bracket_value}\" };" >> "$fixture/packages/dsh-memory/lib/index.js"
git -C "$fixture" add packages/dsh-memory/lib/index.js
git -C "$fixture" show HEAD:packages/dsh-memory/lib/index.js > "$fixture/packages/dsh-memory/lib/index.js"
expect_secret_failure "$fixture" "index-only bracket and comment literal credential assignments"

fixture="$(make_fixture nullish-fallback-index-credential)"
fallback_field="client_""secret"
fallback_value="abcdefghijkl""mnop"
print -- "const ${fallback_field} = process.env.CLIENT_SECRET ?? \"${fallback_value}\";" >> "$fixture/packages/dsh-memory/lib/index.js"
git -C "$fixture" add packages/dsh-memory/lib/index.js
git -C "$fixture" show HEAD:packages/dsh-memory/lib/index.js > "$fixture/packages/dsh-memory/lib/index.js"
expect_secret_failure "$fixture" "an index-only nullish credential fallback"

fixture="$(make_fixture logical-or-fallback-index-credential)"
print -- "const ${fallback_field} = process.env.CLIENT_SECRET || \"${fallback_value}\";" >> "$fixture/packages/dsh-memory/lib/index.js"
git -C "$fixture" add packages/dsh-memory/lib/index.js
git -C "$fixture" show HEAD:packages/dsh-memory/lib/index.js > "$fixture/packages/dsh-memory/lib/index.js"
expect_secret_failure "$fixture" "an index-only logical-or credential fallback"

fixture="$(make_fixture line-comment-colon-index-credential)"
comment_field="client_""secret"
comment_value="abcdefghijkl""mnop"
printf 'const credentials = { %s // deployment value\n: "%s" };\n' "$comment_field" "$comment_value" >> "$fixture/packages/dsh-memory/lib/index.js"
git -C "$fixture" add packages/dsh-memory/lib/index.js
git -C "$fixture" show HEAD:packages/dsh-memory/lib/index.js > "$fixture/packages/dsh-memory/lib/index.js"
expect_secret_failure "$fixture" "an index-only line-comment credential assignment"

fixture="$(make_fixture bracket-inner-comment-index-credential)"
print -- "const credentials = {}; credentials[/* deployment value */ \"${comment_field}\"] = \"${comment_value}\";" >> "$fixture/packages/dsh-memory/lib/index.js"
git -C "$fixture" add packages/dsh-memory/lib/index.js
git -C "$fixture" show HEAD:packages/dsh-memory/lib/index.js > "$fixture/packages/dsh-memory/lib/index.js"
expect_secret_failure "$fixture" "an index-only bracket-inner-comment credential assignment"

fixture="$(make_fixture token-comparison)"
safe_field="to""ken"
print -- "const ${safe_field} = process.env.SAFE_TOKEN; if (${safe_field} === undefined) throw new Error(\"missing token\");" >> "$fixture/packages/dsh-memory/lib/index.js"
git -C "$fixture" add packages/dsh-memory/lib/index.js
expect_secret_success "$fixture" "a safe token environment reference and equality comparison"

fixture="$(make_fixture quoted-generic-credential)"
token_field="to""ken"
token_value="abcdefghijkl""mnop"
print -- "const credentials = { ${token_field}: \"${token_value}\" };" >> "$fixture/packages/dsh-memory/lib/index.js"
git -C "$fixture" add packages/dsh-memory/lib/index.js
expect_secret_failure "$fixture" "a quoted generic credential assignment"

fixture="$(make_fixture fine-grained-github-token)"
github_prefix="github_pat"
github_suffix="11AA22BB33CC44DD55EE66FF77GG88HH99II00JJ"
print -- "const githubCredential = '${github_prefix}_${github_suffix}';" >> "$fixture/packages/dsh-memory/lib/index.js"
git -C "$fixture" add packages/dsh-memory/lib/index.js
expect_secret_failure "$fixture" "a fine-grained GitHub token"

fixture="$(make_fixture binary-index-source)"
node -e 'require("node:fs").writeFileSync(process.argv[1], Buffer.from([255, 254, 253, 252, 251]));' "$fixture/packages/dsh-memory/lib/index.js"
git -C "$fixture" add packages/dsh-memory/lib/index.js
expect_secret_failure "$fixture" "a non-text indexed source"
expect_public_tree_failure "$fixture" "a non-text indexed source"

fixture="$(make_fixture index-worktree-divergence)"
node -e 'const fs=require("node:fs"); const path=process.argv[1]; const manifest=JSON.parse(fs.readFileSync(path,"utf8")); manifest.version="9.9.9"; manifest.private=false; fs.writeFileSync(path, JSON.stringify(manifest, null, 2)+"\n");' "$fixture/packages/dsh-memory/package.json"
git -C "$fixture" add packages/dsh-memory/package.json
git -C "$fixture" show HEAD:packages/dsh-memory/package.json > "$fixture/packages/dsh-memory/package.json"
expect_secret_success "$fixture" "an index-only manifest divergence"
expect_public_tree_failure "$fixture" "an index-only manifest divergence"

fixture="$(make_fixture index-only-merge-marker)"
left_marker="<""<<<<<<"
print -- "${left_marker} synthetic-conflict" >> "$fixture/README.md"
git -C "$fixture" add README.md
git -C "$fixture" show HEAD:README.md > "$fixture/README.md"
expect_public_tree_failure "$fixture" "an index-only unresolved merge marker"

for workspace in dsh-memory dsh-memory-ui; do
  fixture="$(make_fixture "missing-${workspace}-license")"
  git -C "$fixture" update-index --force-remove "packages/${workspace}/LICENSE"
  expect_public_tree_failure "$fixture" "a ${workspace} package artifact without LICENSE"
done

fixture="$(make_fixture package-lifecycle-script)"
lifecycle_name="pre""pack"
node -e 'const fs=require("node:fs"); const path=process.argv[1]; const script=process.argv[2]; const manifest=JSON.parse(fs.readFileSync(path,"utf8")); manifest.scripts={ [script]: "printf \\\"sk-%s\\\" \\\"synthetic-generated-value\\\" > lib/generated.txt" }; fs.writeFileSync(path, JSON.stringify(manifest, null, 2)+"\n");' "$fixture/packages/dsh-memory/package.json" "$lifecycle_name"
git -C "$fixture" add packages/dsh-memory/package.json
expect_secret_success "$fixture" "a lifecycle-only package mutation"
expect_public_tree_failure "$fixture" "a package lifecycle script"

fixture="$(make_fixture symlink)"
link_blob="$(print -- 'index.js' | git -C "$fixture" hash-object -w --stdin)"
git -C "$fixture" update-index --add --cacheinfo "120000,$link_blob,packages/dsh-memory/lib/index.js"
expect_secret_failure "$fixture" "a tracked source symlink"
expect_public_tree_failure "$fixture" "a tracked source symlink"

print -- "dsh-memory release guard tests passed"
