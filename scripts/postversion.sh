#!/usr/bin/env bash
set -euo pipefail

# npm/Bun must leave the version edit uncommitted for this Gitflow workflow.
version="$(node -p 'JSON.parse(require("node:fs").readFileSync("package.json", "utf8")).version')"
if [[ "$(git branch --show-current)" != develop ]]; then
    echo 'Release from develop using bun pm version --no-git-tag-version <patch|minor|major>.' >&2
    exit 1
fi
while IFS= read -r path; do
    if [[ "$path" != package.json && "$path" != bun.lock ]]; then
        echo "Unrelated working-tree change prevents release: $path" >&2
        exit 1
    fi
done < <(git status --porcelain --untracked-files=all | cut -c4-)
if git diff --quiet HEAD -- package.json; then
    echo 'Version must be changed but not committed; use --no-git-tag-version.' >&2
    exit 1
fi
bun install --lockfile-only --ignore-scripts
bun run validate
git add package.json bun.lock
git commit -m "Bump package version to $version" -- package.json bun.lock
git flow release start "$version"
GIT_MERGE_AUTOEDIT=no git flow release finish -m "$version" "$version"
git switch develop
git merge --no-edit main
