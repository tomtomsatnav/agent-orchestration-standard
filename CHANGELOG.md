# Changelog

No tagged releases yet; entries are by theme, newest first.

## Unreleased
- `make` on Windows: runs from Git Bash, cmd and PowerShell (with Git for Windows' bash, found through `git`). `make link` writes two launcher shims (`aos-dash` for Git Bash, `aos-dash.cmd` for cmd and PowerShell) instead of a symlink, and touches only its own launchers; `make stop` and `make doctor` work without lsof, ps or which; `make open` uses `start`; `make start` with its output piped (`make start | tail`) returns instead of waiting until the monitor stops. `make install` no longer stops halfway when an `aos-dash` that is not ours is in the way, and `make stop` on Linux or macOS without lsof now says it could not check instead of "not running". `make test` passes on Windows too, from Git Bash, cmd and PowerShell; the fake-ssh integration test is skipped there, and so is the file-symlink case of the verdicts test when Windows refuses the symlink (no Developer Mode or admin). The guard hook now fires for sessions in a subfolder of a configured repo on Windows (it compared paths with `/` only, so it fired only at the repo root). `make test` prints failure details again on Node 23+ (it forces the TAP reporter that its filters expect).
- Guard view: verdicts of `aos-orch verify` (sandboxed re-run of the original tests + anti-cheat diff analysis) on the dashboard: a badge on session nodes and in the agent drawer (verified / integrity rejection / checks failed), a GUARD panel listing recent verdicts (reasons, failing tests, checks), a Needs-you item for integrity rejections, `GET /api/verdicts` and a `verdicts` summary in `/api/state` (omitted in replay). Optional, off-by-default Stop hook that runs `aos-orch verify` in the background for repos listed in `config.json` (docs/dashboard.md, Guard view). The hook records each session's `HEAD` at SessionStart and verifies against that sha (`--base`), falling back to an explicit sha in config; without either it skips and logs, never defaulting to `main` (an agent committing onto `main` would otherwise get an empty diff and a green verdict).
- Optional exact cost: the monitor accepts Claude Code's OpenTelemetry metrics (OTLP http/json on /v1/metrics) and shows exact cost split into main, subagents (by type) and background calls (docs/otel.md). Suggested in a LinkedIn comment.
- `aos-dash --json` and the cross-machine collector (SSH, read-only).
- Spec and orchestrator split out into their own repos (aos-1-spec, aos-orchestrator); this repo keeps the UI, monitor and plugin.
- Monitor tests decoupled from the orchestrator via golden goal fixtures; on-disk contract documented.
- Goals view: per-task outcome summary; goals UI backed by the orchestrator control server.
- Web UI: streams modes (Full / Quiet / Lines), semantic zoom, fixes for reduced motion.
- CI on Linux and macOS (Node 18 and 22); notifier tests run on macOS only.

## Earlier
- Pre-release security and privacy hardening; fixes for malformed-log crashes, prototype-key cost bug, paths with spaces.
- Static project-graph layout with pan and zoom, light/dark theme, scaled terminal view, make-based setup, MIT license.
- Initial commit: live dashboard for Claude Code (hooks, monitor, web UI, terminal UI, MCP server).
