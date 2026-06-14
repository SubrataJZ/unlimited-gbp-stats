# Git hooks

This repo ships its hooks in `.githooks/` (version-controlled, unlike the default
`.git/hooks/`). **Each clone must opt in once:**

```sh
git config core.hooksPath .githooks
```

(On Windows, run it in Git Bash or any shell — it's a git config, not OS-specific.)

## `pre-commit` — SemVer guard

Blocks a commit when product code changed without a matching version bump, so the
project's versioning policy can't be silently skipped:

| If you change…                                   | You must also bump…                         |
|--------------------------------------------------|---------------------------------------------|
| `unlimited-gbp-stats/**` (extension)             | `manifest.json` `version` **+** `CHANGELOG.md` |
| `unlimited-gbp-stats/server/**`                  | `server/package.json` `version`             |
| `backend/**`                                     | `backend/package.json` `version`            |

SemVer: **PATCH** = bug fix · **MINOR** = new feature · **MAJOR** = breaking change.

Intentional bypass (rare): `git commit --no-verify`.
