#!/usr/bin/env bash
set -euo pipefail
source_root="$(git rev-parse --show-toplevel)"
fixture="$(mktemp -d "${TMPDIR:-/tmp}/caldav-mcp-release.XXXXXX")"
trap 'rm -rf "$fixture"' EXIT
mkdir -p "$fixture/scripts" "$fixture/fixture-dependency"
cp "$source_root/scripts/postversion.sh" "$source_root/scripts/init-gitflow.sh" "$fixture/scripts/"
cd "$fixture"
git init -q -b main
git config user.name 'Release regression'
git config user.email 'release-test@example.invalid'
cat > package.json <<'JSON'
{"name":"release-regression","version":"0.1.0","dependencies":{"fixture-dependency":"file:./fixture-dependency"},"scripts":{"postversion":"bash scripts/postversion.sh","validate":"node -e 'process.exit(0)'"}}
JSON
printf '%s\n' '{"name":"fixture-dependency","version":"1.0.0"}' > fixture-dependency/package.json
bun install --lockfile-only --ignore-scripts >/dev/null
git add package.json bun.lock scripts fixture-dependency
git commit -qm 'Initialize disposable release fixture'
git switch -qc develop
bash scripts/init-gitflow.sh
bun pm version patch --no-git-tag-version
[[ "$(git branch --show-current)" == develop ]]
[[ "$(git show main:package.json | node -e 'let s=""; process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).version))')" == 0.1.1 ]]
[[ "$(git rev-parse '0.1.1^{commit}')" == "$(git rev-parse main)" ]]
git merge-base --is-ancestor main develop
[[ -z "$(git status --porcelain)" ]]
# The recorded lockfile agrees with a fresh frozen install after release.
bun install --frozen-lockfile --ignore-scripts >/dev/null
