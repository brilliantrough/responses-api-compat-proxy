# Publishing Checklist

Run this checklist before adding a public `origin` or pushing the repository to a public remote.

## Secrets and Local Runtime Data

- [ ] No real `.env` files are tracked.
- [ ] No `instances/proxy-*` directories are tracked.
- [ ] No real API keys, tokens, or provider secrets appear in `git diff`.
- [ ] Tracked JSON examples use placeholder URLs and placeholder secret environment variable names only.

## Local Environment Leakage

- [ ] No home-directory absolute paths remain in tracked docs or templates.
- [ ] No private hostnames, server names, or local IPs remain in tracked files.
- [ ] No local systemd unit names or deployment-specific service names remain unless they are intentionally generic examples.
- [ ] No internal progress notes or operator-only memory files are included in the public diff.

## Runtime Artifacts

- [ ] `logs/`, `captures/`, `sse-failures/`, and similar debug output directories are not tracked.
- [ ] Debug toggles remain disabled in example files.
- [ ] No raw request or response dumps are present in tracked files.

## Public Docs Quality

- [ ] `README.md` gives a shortest-path onboarding flow.
- [ ] `docs/quickstart.md` works from a clean checkout.
- [ ] `docs/examples.md` matches the current example files.
- [ ] `docs/configuration.md` distinguishes required, common, advanced, and debug settings.
- [ ] `docs/operations.md` warns clearly about localhost-only admin access and sensitive captures.

## Repository Metadata

- [ ] A license has been chosen and added.
- [ ] `origin` points to the intended public remote.
- [ ] `git status --short` shows only intentional changes.
- [ ] `git diff --stat` looks intentional and public-safe.

## Recommended Final Commands

```bash
git status --short
git diff --stat
git diff
```

If any diff still contains real credentials, local paths, or operator-only notes, fix that before pushing.
