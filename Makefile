# AOS: one-command setup for the Claude Code live dashboard.   Run `make` for the list of targets.
# Requires: Node 18+, the Claude Code CLI (`claude`), macOS for the branded notifier (everything else is portable).

SHELL      := /bin/bash
# make from cmd or PowerShell (Windows outside Git Bash, where MSYSTEM is unset): /bin/bash does not exist there, so make
# would fall back to cmd.exe and every recipe would fail ('PORT' is not recognized...). (A make that has its own
# /bin/bash, such as Cygwin's, is not this case and keeps SHELL as it is.) Locate Git for Windows through `git` (on the
# PATH of any shell that can run it), run the recipes with its bash, put its usr/bin first so they find tail, awk,
# uname and start (curl is Windows' own, in System32), and give make and bash the HOME that node and Claude Code use
# (their home is USERPROFILE; an inherited HOME that differs would point DATA somewhere else). The exec path is
# <root>/<mingw64|mingw32|clangarm64>/libexec/git-core; any other layout (not Git for Windows), or a git without a bash
# that runs (MinGit, the git bundled with GitHub Desktop), stops with a message instead of a SHELL that is not there.
ifeq ($(OS),Windows_NT)
ifeq ($(MSYSTEM)$(wildcard /bin/bash /bin/bash.exe),)
GIT_EXEC   := $(shell git --exec-path)
GIT_ROOT   := $(strip $(foreach d,mingw64 mingw32 clangarm64,$(if $(findstring /$(d)/libexec/git-core,$(GIT_EXEC)),$(subst /$(d)/libexec/git-core,,$(GIT_EXEC)))))
ifeq ($(GIT_ROOT),)
$(error git not found on PATH, or not Git for Windows ($(or $(GIT_EXEC),no git)): make needs Git for Windows (its bash runs the recipes). Install it or run make from Git Bash)
endif
GIT_BASH   := $(GIT_ROOT)/usr/bin/bash.exe
GIT_BASH_OK := $(shell "$(GIT_BASH)" -c "echo ok")
ifeq ($(GIT_BASH_OK),)
$(error $(GIT_BASH) is missing or does not run: make needs the bash of a full Git for Windows (not MinGit). Install it or run make from Git Bash)
endif
SHELL      := $(GIT_BASH)
export PATH := $(GIT_ROOT)/usr/bin;$(PATH)
HOME       := $(USERPROFILE)
export HOME
endif
endif
REPO       := $(CURDIR)
PLUGIN     := aos-dashboard@aos-local
MARKET     := aos-local
PORT       ?= 4318
DATA       := $(HOME)/.claude/plugins/data/aos-dashboard-aos-local
AOS        := node scripts/aos.mjs
ENSURE     := CLAUDE_PLUGIN_ROOT="$(REPO)/plugin" CLAUDE_PLUGIN_DATA="$(DATA)" AOS_PORT=$(PORT) node plugin/hooks/ensure-monitor.mjs
# make for Windows hands the shell inheritable copies of its output handles, and they pass through bash and node to the
# detached monitor, which then holds a pipe open (`make start | tail` would wait until the monitor stops). Node cannot
# close a handle it has no fd for, so start ensure-monitor through Start-Process, whose child inherits no handles (only
# the environment) and which returns at once, so `start` waits for the monitor itself. The path goes through the
# environment, so PowerShell never parses it; [char]34 is a double quote.
ifeq ($(OS),Windows_NT)
ENSURE     := CLAUDE_PLUGIN_ROOT="$(REPO)/plugin" CLAUDE_PLUGIN_DATA="$(DATA)" AOS_PORT=$(PORT) AOS_ENSURE="$(REPO)/plugin/hooks/ensure-monitor.mjs" powershell -NoProfile -NonInteractive -Command 'Start-Process -WindowStyle Hidden -FilePath node -ArgumentList ([char]34 + $$env:AOS_ENSURE + [char]34)'
endif
# One browser opener per platform, so its own error shows if it fails. OS is Windows_NT in cmd, PowerShell and Git Bash
# alike; elsewhere `open` is only right on macOS (on Debian/Ubuntu it is openvt). `=`, so uname runs only for `make open`.
ifeq ($(OS),Windows_NT)
OPEN       := start
else
OPEN        = $(if $(filter Darwin,$(shell uname -s)),open,xdg-open)
endif

.DEFAULT_GOAL := help
.PHONY: help install uninstall build validate test doctor start stop restart open link unlink statusline statusline-off notifier screenshots

help: ## Show this list
	@echo "AOS: Claude Code live dashboard"; echo
	@grep -E '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*## "}{printf "  make %-16s %s\n", $$1, $$2}'
	@echo; echo "First time:  make install   then start a NEW Claude Code session and open http://127.0.0.1:$(PORT)"

# `link` fails when an aos-dash that is not ours is in the way. The plugin is installed by then, so the install goes on
# to start the monitor instead of stopping halfway.
install: check build validate ## Install everything: build, register + install the plugin, link `aos-dash`, build the notifier, start the monitor
	@echo "==> registering the local marketplace"
	@claude plugin marketplace add "$(REPO)" 2>&1 | tail -1 || true
	@echo "==> installing $(PLUGIN)"
	@claude plugin install $(PLUGIN) 2>&1 | tail -1 || true
	@$(MAKE) --no-print-directory link || echo "  ! aos-dash not linked (reason above); the install goes on, the web dashboard does not need it"
	@$(MAKE) --no-print-directory notifier
	@$(MAKE) --no-print-directory start
	@echo; echo "Done. Next:"
	@echo "  1. Start a NEW Claude Code session (existing sessions keep their old hooks; or type /reload-plugins)"
	@echo "  2. Open http://127.0.0.1:$(PORT)   (or run: aos-dash)"
	@echo "  3. Optional status line:  make statusline"
	@echo "  4. Check everything:      make doctor"
	@echo "Troubleshooting: aos-dash not found -> put ~/.local/bin on your PATH (Git Bash, zsh, bash: add to your shell profile: export PATH=\"\$$HOME/.local/bin:\$$PATH\"; cmd and PowerShell: add %USERPROFILE%\\.local\\bin to your user PATH, make link prints how); empty dashboard -> normal until a Claude Code session has run (it fills from hook events)."
	@echo "NOTE: if you previously added AOS hooks to ~/.claude/settings.json by hand, remove them (they would log every event twice)."

# `stop` fails when it cannot identify the listener on PORT (right for `restart`) and `statusline-off` when settings.json cannot
# be read; here each only prints its reason, and the uninstall goes on to remove the plugin.
uninstall: ## Remove the plugin, marketplace entry, aos-dash link and status line (your data stays)
	@PORT=$(PORT) $(AOS) stop || true
	@$(MAKE) --no-print-directory unlink || true
	@$(MAKE) --no-print-directory statusline-off || true
	-@claude plugin uninstall $(PLUGIN) 2>&1 | tail -1
	-@claude plugin marketplace remove $(MARKET) 2>&1 | tail -1
	@echo "Removed. Activity history is kept in $(DATA) (delete it to erase)."

check:
	@command -v node >/dev/null || { echo "node not found (need 18+)"; exit 1; }
	@node -e 'process.exit(+process.versions.node.split(".")[0] >= 18 ? 0 : 1)' || { echo "node 18+ required"; exit 1; }
	@command -v claude >/dev/null || { echo "claude CLI not found: install Claude Code first"; exit 1; }

build: ## Regenerate plugin/ copies (monitor, hooks, ui, cli) from the sources
	@set -o pipefail; node plugin/build.mjs | tail -3

validate: ## Validate the plugin manifest with the Claude CLI
	@set -o pipefail; claude plugin validate ./plugin 2>&1 | tail -2

test: ## Run every test suite
	@set -o pipefail; echo "==> terminal dashboard"; node cli/test.mjs | tail -1
	@set -o pipefail; echo "==> MCP server"; node plugin/mcp/test.mjs | tail -1
	@if [ "$$(uname)" = "Darwin" ]; then set -o pipefail; echo "==> notifier"; node plugin/notify/test.mjs | tail -1; else echo "==> notifier: skipped (macOS only)"; fi
	@set -o pipefail; echo "==> aos helper (stop/doctor)"; node scripts/aos.test.mjs | tail -1
	@echo "==> theme contrast"; out="$$(node ui/theme-tokens.test.mjs)" || { echo "$$out"; exit 1; }; echo "$$out" | head -1
	@echo "==> streams quiet mode"; out="$$(node ui/streams-quiet.test.mjs)" || { echo "$$out" | grep FAIL; exit 1; }; echo "$$out" | tail -1
	@echo "==> mobile layout"; out="$$(node ui/mobile.test.mjs)" || { echo "$$out" | grep FAIL; exit 1; }; echo "$$out" | tail -1
	@echo "==> orch badges"; out="$$(node ui/orch-badges.test.mjs)" || { echo "$$out" | grep FAIL; exit 1; }; echo "$$out" | tail -1
	@echo "==> orch rules + draft"; out="$$(node ui/orch-rules.test.mjs)" || { echo "$$out" | grep FAIL; exit 1; }; echo "$$out" | tail -1
	@echo "==> orch presence"; out="$$(node ui/orch-presence.test.mjs)" || { echo "$$out" | grep FAIL; exit 1; }; echo "$$out" | tail -1
	@echo "==> needs-you"; out="$$(node ui/needs-you.test.mjs)" || { echo "$$out" | grep FAIL; exit 1; }; echo "$$out" | tail -1
	@echo "==> guard view"; out="$$(node ui/guard.test.mjs)" || { echo "$$out" | grep FAIL; exit 1; }; echo "$$out" | tail -1
	@echo "==> done subagents"; out="$$(node ui/done.test.mjs)" || { echo "$$out" | grep FAIL; exit 1; }; echo "$$out" | tail -1
	@echo "==> machines (cross-machine UI)"; out="$$(node ui/machines.test.mjs)" || { echo "$$out" | grep FAIL; exit 1; }; echo "$$out" | tail -1
	@echo "==> timeline"; out="$$(node ui/timeline.test.mjs)" || { echo "$$out" | grep FAIL; exit 1; }; echo "$$out" | tail -1
	@echo "==> monitor goals, verdicts + hooks"; out="$$(node --test --test-reporter=tap tests-monitor/*.test.mjs 2>&1)" || { echo "$$out" | grep -E "^not ok|error:" | head -20; exit 1; }; echo "$$out" | grep -E '^# (pass|fail)' | tr '\n' ' '; echo

doctor: ## Check the whole setup and say what to fix
	@$(AOS) doctor

start: ## Start the live monitor (normally automatic when a session opens)
	@$(ENSURE); for i in $$(seq 20); do curl -s -o /dev/null -m 1 http://127.0.0.1:$(PORT)/api/state && break; sleep 0.25; done; curl -s -o /dev/null -m 2 -w "monitor on :$(PORT): HTTP %{http_code}\n" http://127.0.0.1:$(PORT)/api/state || echo "monitor did not start: see make doctor"

stop: ## Stop the live monitor on PORT (other AOS monitors are left alone)
	@PORT=$(PORT) $(AOS) stop

restart: stop start ## Restart the monitor (needed after `make build` changes monitor.mjs)

open: ## Open the web dashboard
	@$(OPEN) http://127.0.0.1:$(PORT) || echo "Open http://127.0.0.1:$(PORT) in your browser"

link: ## Put `aos-dash` on your PATH (symlink in ~/.local/bin; launcher scripts on Windows)
	@$(AOS) link

unlink: ## Remove the `aos-dash` link
	@$(AOS) unlink

statusline: ## (optional) Show an AOS summary in Claude Code's status line (edits ~/.claude/settings.json, with backup)
	@$(AOS) statusline

statusline-off: ## Remove the AOS status line
	@$(AOS) statusline-off

notifier: ## (macOS) Build the branded notification app
	@node plugin/notify/build-notifier.mjs 2>&1 | tail -2

screenshots: ## Regenerate docs/screenshots + docs/hero.gif from synthetic demo data (needs the monitor running, playwright-core; ffmpeg for the GIF)
	@node scripts/screenshots.mjs
