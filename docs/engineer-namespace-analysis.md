# Engineer Namespace — Complete Analysis

> **HISTORICAL (pre-PLN-252).** This document captures the `/api/engineer/*` namespace as it existed before it was renamed to `/api/gateway/*` and the 62 Next.js route handlers under `apps/app/app/api/engineer/` were deleted in favor of native gateway operations in `closedloop-electron`. URLs, file paths, and architecture diagrams below reflect that prior state. Preserved as a historical record of the analysis that motivated the rename; do not treat it as current reference material.

## Table of Contents

1. [Overview](#overview)
2. [Security Model](#security-model)
3. [Architecture Summary](#architecture-summary)
4. [Feature Catalog](#feature-catalog)
   - [Dashboard & Ticket Management](#1-dashboard--ticket-management)
   - [ClosedLoop Launch & Orchestration](#2-closedloop-launch--orchestration)
   - [ClosedLoop Chat](#3-closedloop-chat)
   - [Codex Review](#4-codex-review)
   - [Codex Debate (Claude vs Codex)](#5-codex-debate-claude-vs-codex)
   - [PR Comment Chat](#6-pr-comment-chat)
   - [Terminal Chat](#7-terminal-chat)
   - [Ticket Chat (Pre-Planning)](#8-ticket-chat-pre-planning)
   - [Run Viewer Chat](#9-run-viewer-chat)
   - [Git Operations](#10-git-operations)
   - [PR Management](#11-pr-management)
   - [Deploy (Local Dev Server)](#12-deploy-local-dev-server)
   - [Learnings Pipeline](#13-learnings-pipeline)
   - [Repo Management](#15-repo-management)
   - [Health Check](#16-health-check)
   - [Commit Message Generation](#17-commit-message-generation)
   - [Version & Update Checker](#18-version--update-checker)
   - [File Search & Directory Browsing](#19-file-search--directory-browsing)
5. [Remote Deployability — Original Assessment](#remote-deployability--original-assessment)
6. [Remote Deployability — With Electron Shell Relay (Low-Level)](#remote-deployability--with-electron-shell-relay)
   - [Relay Primitive Catalog](#relay-primitive-catalog)
   - [Per-Feature Relay Assessment](#per-feature-relay-assessment)
   - [Relay Feasibility Summary](#relay-feasibility-summary)
   - [Relay Architecture Sketch](#relay-architecture-sketch)
   - [Challenges & Risks](#challenges--risks)
7. [Remote Deployability — With Plugin-Based High-Level Operations](#remote-deployability--with-plugin-based-high-level-operations)
   - [Why High-Level Operations Win](#why-high-level-operations-win)
   - [Architecture](#architecture-1)
   - [Operation Catalog](#operation-catalog)
   - [What Crosses the Wire](#what-crosses-the-wire)
   - [What Stays Entirely Local](#what-stays-entirely-local)
   - [Streaming Protocol](#streaming-protocol)
   - [Approval UX](#approval-ux)
   - [Remaining Challenges](#remaining-challenges)
8. [Phase 6: Desktop Client for Non-Engineers](#phase-6-desktop-client-for-non-engineers)
   - [Audience Shift](#audience-shift)
   - [Why Electron](#why-electron-not-cli-not-tauri)
   - [Architecture](#architecture-2)
   - [Approval Model](#approval-model)
   - [Onboarding Flow](#onboarding-flow-non-engineer-optimized)
   - [Data Flow](#data-flow-web-ui--desktop-client)
   - [Reconnect Protocol](#reconnect-protocol)
   - [Security Model](#security-model-1)
   - [Reference Products](#reference-products)
   - [Effort Estimates](#effort-estimates-1)
   - [LLM Buildability](#llm-buildability-75)
   - [Top Risks](#top-risks)
9. [Communication Patterns Reference](#communication-patterns-reference)
10. [Type System Reference](#type-system-reference)

---

## Overview

The Engineer namespace is a localhost-only AI coding assistant UI integrated into the ClosedLoop platform. It occupies:

- **UI**: `apps/app/app/(authenticated)/engineer/` (pages), `apps/app/components/engineer/` (~60+ components), `apps/app/hooks/engineer/` (~15 hooks)
- **API**: `apps/app/app/api/engineer/` (~70+ route handlers) — all inside `apps/app`, NOT in `apps/api`
- **Lib**: `apps/app/lib/engineer/` (utilities, query factories, stream parsers)
- **Types**: `apps/app/types/engineer.ts`, `apps/app/types/repos.ts`, `apps/app/types/run-viewer.ts`, `apps/app/components/engineer/chat/types.ts`

The feature exists entirely within `apps/app` because it requires local filesystem access and the ability to spawn CLI processes (claude, codex, git, gh).

---

## Security Model

### Two-Layer Guard

**Layer 1 — HTTP Middleware (Real Security)**: `apps/app/proxy.ts`

```
engineerGuard() intercepts ALL /api/engineer/* requests
  → Reads Host header, strips port
  → If hostname not in {"localhost", "127.0.0.1"} → 403 Forbidden
  → Runs inside Clerk authMiddleware, fires BEFORE route handlers
```

**Layer 2 — UX Guard (Cosmetic)**: `apps/app/app/(authenticated)/engineer/engineer-guard.tsx`

```
Client-side check: appEnvironment derived from NEXT_PUBLIC_APP_URL
  → If URL contains "localhost" → "local" → renders EngineerDashboard
  → Otherwise → shows "not available" message
  → NOT a security control — can be bypassed by any HTTP client
```

### Authentication

- Only ONE route uses Clerk auth: `POST /api/engineer/git` (`await auth()`)
- All other routes rely exclusively on the localhost guard
- The `(authenticated)` layout requires Clerk sign-in for the page itself

### Path Validation

- `isRepoAllowed(path)` in `lib/engineer/repos.ts` prevents path traversal
- Validates paths against `~/.closedloop-ai/repos.json` config
- Worktree validation checks actual `.git` pointer linkage, not just naming

---

## Architecture Summary

```
engineer/page.tsx
  └── EngineerGuard (localhost UX check)
       └── EngineerDashboard
            ├── HeaderOverflowMenu (theme, learnings, run viewer, PRs)
            └── TicketList (~2100 lines, central orchestrator)
                 ├── ActiveTicketCard (per active ClosedLoop session)
                 │    ├── PlanViewer (sliding panel)
                 │    ├── SymphonyChat (tabbed: chat / changes / comments)
                 │    ├── SymphonyStatus (polling w/ agent timers)
                 │    ├── LogViewer / JudgesViewer
                 │    └── OverflowMenu
                 ├── TicketCard (grid) / TicketListRow (list)
                 └── Dialogs: Commit, Deploy, Close, CodexReview,
                      TicketChat, TerminalChat, Learnings, PRBrowser,
                      LinkPR, CommentChat, HealthCheck, Changelog

Contexts:
  └── EngineerThemeProvider (CSS variable overrides)

Data Flow:
  UI Components → TanStack Query hooks → fetch() → /api/engineer/* routes
  Streaming:      useChatStream hook → fetch + ReadableStream → NDJSON parsing
```

---

## Feature Catalog

### 1. Dashboard & Ticket Management

**What it does**: Main engineer view showing tickets organized into Active Work, Next Up (starred), Pending Work, and Done sections. Supports grid/list view modes. Auto-redirects ENGINEER-role users to `/engineer` on localhost.

**UI Components**:
- `EngineerDashboard` — shell with terminal-style header, status widget
- `TicketList` (~2100 lines) — central orchestrator managing all ticket state
- `TicketCard` / `TicketListRow` — per-ticket display with workflow progress bar
- `ActiveTicketCard` — expanded card for active ClosedLoop sessions with sliding plan panel

**API Routes**:
| Route | Method | Purpose |
|-------|--------|---------|
| `/api/engineer/work-directory/[ticketId]` | GET | Check if worktree exists, return pendingClaudeMd, branchStatus |

**Communication**: On mount, `TicketList` fires parallel GET requests to `work-directory` for each ticket to populate `workDirStatus`. Tickets come from the API.

**Local dependencies**: `work-directory` checks local filesystem for worktrees and runs `git status`, `git rev-parse`, `git ls-remote`, `git branch --merged`.

---

### 2. ClosedLoop Launch & Orchestration

**What it does**: Launches the ClosedLoop AI coding loop (`run-loop.sh`) for a ticket, creating a git worktree, writing a `prd.md`, and spawning a detached process. Tracks active sessions. Supports killing running sessions.

**UI Components**:
- `RepoPickerDialog` — two-step: select repo, add context (with @-file autocomplete and branch picker)
- `SymphonyStatus` — polls status every 2s, shows phase text and active agent badges with live timers

**Hooks**:
- `useSymphonyLaunch` — `launch()`, `clearSession()`, `activeSessions` management

**API Routes**:
| Route | Method | Purpose |
|-------|--------|---------|
| `/api/engineer/symphony/launch` | POST | Create worktree, write prd.md, spawn `run-loop.sh` |
| `/api/engineer/symphony/kill` | POST | SIGTERM/SIGKILL process group, delete state file |
| `/api/engineer/symphony/status/[ticketId]` | GET | Read state.json, check process liveness, plan progress |
| `/api/engineer/symphony/status` | GET | Simpler variant: read state.json by workDir |
| `/api/engineer/symphony/sessions` | GET/POST/DELETE | CRUD for `~/.symphony/sessions.json` |

**Communication**:
- Launch: POST with `{ ticketIdentifier, repoPath, ticket?, baseBranch? }` → creates worktree, spawns `run-loop.sh` detached
- Status polling: GET every 2-3s → reads `state.json`, checks `/proc/{pid}` or `kill(pid, 0)`, reads `plan.json` for task progress
- Kill: POST with `{ pid }` or `{ ticketId, repoPath }` → `process.kill(-pid, "SIGTERM")`

**Shell commands spawned**:
- `git branch`, `git symbolic-ref`, `git worktree add`, `git fetch origin`
- `run-loop.sh` (detached child process with stdout/stderr → log file)

**Local dependencies**: Git worktree creation, filesystem writes (prd.md, attachments, log file, PID file), detached process spawning, process group kill (`-pid` SIGTERM/SIGKILL), signal-0 liveness checks, filesystem reads (state.json, plan.json, .agent-types/).

---

### 3. ClosedLoop Chat

**What it does**: Interactive chat with Claude within an active ClosedLoop session. Supports streaming responses with tool use visualization, thinking blocks, and context window usage tracking. Part of the `ActiveTicketCard` tabbed interface (Chat / Changes / Comments tabs).

**UI Components**:
- `SymphonyChat` — full chat dialog with tabs
- `ChatBubble`, `ChatInput`, `MessageContent`, `UserMessageContent`
- `CollapsibleBlock` / `CollapsibleBlockGroup` — expandable tool use/result blocks
- `SubagentBlock` — sub-agent execution display
- `SlashCommandDropdown` — floating slash command picker

**Hooks**:
- `useChatStream` — shared streaming hook (POST → ReadableStream → NDJSON parsing)
- `useSlashCommands` — slash command detection, filtering, keyboard nav

**API Routes**:
| Route | Method | Purpose |
|-------|--------|---------|
| `/api/engineer/symphony/chat/[ticketId]` | POST | Spawn `claude` CLI, stream NDJSON responses |
| `/api/engineer/symphony/chat-history` | GET/DELETE | Read/clear chat history |

**Communication**:
- POST `{ message, displayContent?, activeTab?, contextRepoPaths?, codexReview?, codexAvailable? }`
- Response: SSE-style stream (`Content-Type: text/event-stream`) with NDJSON events
- Wire format events: `status`, `text`, `tool_use`, `tool_result`, `thinking`, `usage`, `learnings`, `error`, `result`, `done`
- Client parses via `readChatStream()` → dispatches to `StreamEventHandlers`
- Session resume via `--resume sessionId` flag (read from `chat-history.json`)

**Shell commands spawned**:
- `claude -p --model opus --verbose --output-format stream-json --allowedTools=Bash,Grep,Glob,Read,Edit,Write,Task,TodoWrite,WebSearch,WebFetch,mcp__closedloop__* [--resume sessionId]`

**Local dependencies**: Spawns `claude` CLI with stdin pipe and stdout streaming, reads/writes `chat-history.json`, reads `plan.json`/`prd.md`/`org-patterns.toon` for context, SIGTERM on cancel, kill timer (30s SIGTERM + 5s SIGKILL after result event).

---

### 4. Codex Review

**What it does**: Runs a code review using either Codex (OpenAI) or Claude as the review provider. Streams review output, extracts structured findings, and supports deduplication.

**UI Components**:
- `CodexReviewDialog` — start/view review with provider selection
- `CodexReviewSettingsDialog` — configure review settings
- `ReviewChatPane` — chat about review findings with file resolution

**Hooks**:
- `useChatStream` (shared)
- `useCodexReviewStatus` — polls status every 2s while running
- `useCodexAvailable` — one-time check if `codex` CLI exists

**API Routes**:
| Route | Method | Purpose |
|-------|--------|---------|
| `/api/engineer/codex/review/[ticketId]` | POST | Spawn `codex review` or `claude` for review (SSE stream) |
| `/api/engineer/codex/status/[ticketId]` | GET/DELETE | Read review state/log; clear review files |
| `/api/engineer/codex/stop/[ticketId]` | POST/DELETE | Kill review process |
| `/api/engineer/codex/review-extract` | POST | Extract structured findings from raw output |
| `/api/engineer/codex/review-dedup` | POST | Deduplicate findings |
| `/api/engineer/codex/review-findings` | GET/POST | Manage persisted findings |
| `/api/engineer/codex/finding-chat` | POST | Chat about a specific finding |
| `/api/engineer/codex/available` | GET | Check `codex --version` exit code |

**Shell commands spawned**:
- `codex review [flags]` (detached)
- `claude -p --model {model} --allowedTools ... --append-system-prompt ...` (detached)
- `git diff`, `git merge-base`, `git rev-parse`, `git checkout`, `git apply`
- `gh pr diff`, `gh pr view`

**Local dependencies**: Most complex single route — uses 8 distinct shell commands (git, gh, codex, claude), writes temporary patch files, uses both streaming and detached spawns, inline kill timers, signal-0 liveness checks, and log file appending.

---

### 5. Codex Debate (Claude vs Codex)

**What it does**: A structured multi-turn debate between Claude and Codex (OpenAI) about code, findings, or approaches. Up to 10 rounds, can auto-advance. Tracks debate status via XML blocks in messages.

**UI Components**: Integrated into `SymphonyChat` and `CodexReviewDialog` via the debate hook

**Hooks**:
- `useCodexDebate` (~946 lines) — full debate state machine

**API Routes**:
| Route | Method | Purpose |
|-------|--------|---------|
| `/api/engineer/codex/argue/[ticketId]` | POST | Forward Claude's argument to Codex, stream response |
| `/api/engineer/codex/chat/[ticketId]` | POST | General Codex chat (SSE stream) |
| `/api/engineer/symphony/chat/[ticketId]` | POST | Claude side of debate (reuses symphony chat) |

**Shell commands spawned**:
- `codex exec [resume <sessionId>] --full-auto --json -m gpt-5.3-codex [prompt]`
- `claude -p` (via symphony chat route)

**Local dependencies**: Spawns both `codex` and `claude` CLI, reads/writes `codex-debate.json` session state, auto-retries on stale sessions.

---

### 6. PR Comment Chat

**What it does**: Per-PR-comment chat sessions where Claude investigates a review comment and proposes a fix. Supports committing fixes and marking comments as addressed.

**UI Components**:
- `CommentChatDialog`, `CommentChat`, `PRCommentCard`

**Hooks**:
- `useCommentChat` — auto-starts with investigation prompt, handles `worktree_resolved`, commit+resolve flow

**API Routes**:
| Route | Method | Purpose |
|-------|--------|---------|
| `/api/engineer/symphony/comment-chat/[commentId]` | GET/POST/DELETE/PATCH | CRUD for comment chat + streaming |

**Shell commands spawned**:
- `claude -p --model opus --allowedTools=ENGINEER_CHAT_TOOLS [--resume sessionId]`
- `git worktree list --porcelain`, `git worktree add` (for PR worktree resolution)

**Local dependencies**: Spawns `claude` CLI, operates in local worktree, reads/writes comment chat JSON, SIGTERM on cancel, kill timer.

---

### 7. Terminal Chat

**What it does**: General-purpose developer chat terminal, not tied to any specific ticket. Routes to Claude (default) or Codex (`@codex` prefix).

**UI Components**: `TerminalChatDialog`

**API Routes**:
| Route | Method | Purpose |
|-------|--------|---------|
| `/api/engineer/terminal-chat` | GET/POST/DELETE | Chat history and streaming |

**Shell commands spawned**:
- `claude -p --verbose --output-format stream-json --allowedTools=WebSearch,WebFetch,Bash,mcp__closedloop__* [--resume]`
- `codex exec [resume sessionId] --full-auto --json -m codex-mini-latest [message]`
- `git remote get-url origin`, `git rev-parse --abbrev-ref HEAD` (per configured repo, for context)

**Local dependencies**: Spawns `claude`/`codex` CLI, reads/writes terminal chat history, reads `CLAUDE.md` per configured repo, reads `org-patterns.toon`.

---

### 8. Ticket Chat (Pre-Planning)

**What it does**: Chat about a Linear ticket before any ClosedLoop session is started. Uses read-only or web-only tools depending on whether a repo path is provided.

**UI Components**: `TicketChatDialog`

**API Routes**:
| Route | Method | Purpose |
|-------|--------|---------|
| `/api/engineer/ticket-chat` | GET/POST/DELETE | Chat history and streaming |

**Shell commands spawned**:
- `claude -p --model opus --allowedTools=READONLY_CODEBASE_TOOLS|WEB_ONLY_TOOLS`

**Local dependencies**: Spawns `claude` CLI, reads/writes ticket chat history.

---

### 9. Run Viewer Chat

**What it does**: Chat about ClosedLoop run artifacts (plan.json, logs, etc.) from the Run Viewer dialog.

**UI Components**: `RunViewerDialog`, `RunOverviewDashboard`, `RunViewerChatPanel`, `FileTreeSidebar`, `ContentViewer`

**API Routes**:
| Route | Method | Purpose |
|-------|--------|---------|
| `/api/engineer/run-viewer-chat` | GET/POST/DELETE | Chat about run artifacts |

**Shell commands spawned**:
- `claude -p --model opus --allowedTools=READONLY_CODEBASE_TOOLS|WEB_ONLY_TOOLS`

**Local dependencies**: Spawns `claude` CLI, reads run artifacts from `/tmp/run-viewer-*`.

---

### 10. Git Operations

**What it does**: Core git operations — branch, commit, push, pull, status, sync-status, branch-diff. Push includes AI-assisted conflict resolution.

**UI Components**: `CommitDialog`, `ChangedFilesViewer`

**Hooks**: `useGitOperations`

**API Routes**:
| Route | Method | Purpose |
|-------|--------|---------|
| `/api/engineer/git` | POST | Multi-action: branch, commit, push, pull, status, branch-diff, sync-status |
| `/api/engineer/git/branches` | GET | Default branch, worktrees, all branches with dates |
| `/api/engineer/git/diff` | POST | File diff (branch vs base, or working tree vs HEAD) |
| `/api/engineer/git/worktree` | DELETE/POST | Remove worktree; clean stale PR worktrees |

**Shell commands spawned**: All git operations via `simple-git` (internally calls `git`), plus `claude --model sonnet` for conflict resolution.

**Local dependencies**: Local `.git` directory, worktree management, `simple-git` library. This is the only route with Clerk auth.

---

### 11. PR Management

**What it does**: Create PRs, list PRs, fetch/post comments, fetch/submit reviews, reply to threads. All via `gh` CLI.

**UI Components**: `PRBrowserDialog`, `PRCommentsViewer`, `LinkPRDialog`

**API Routes**:
| Route | Method | Purpose |
|-------|--------|---------|
| `/api/engineer/git/pr` | POST | Create PR via `gh pr create` |
| `/api/engineer/git/pr/list` | GET | List PRs via `gh pr list --json` |
| `/api/engineer/git/pr/comments` | GET | Fetch PR comments via `gh api` |
| `/api/engineer/git/pr/inline-comment` | POST | Post inline/general comment via `gh api` |
| `/api/engineer/git/pr/files` | GET | List PR changed files via `gh api` |
| `/api/engineer/git/pr/head-sha` | GET | Current HEAD SHA |
| `/api/engineer/git/pr/reviews` | GET/POST | Fetch/submit reviews via `gh api` |
| `/api/engineer/git/pr/reply` | POST | Reply to threads via `gh api` |
| `/api/engineer/git/user` | GET | GitHub login via `gh api user` |

**Shell commands spawned**: `gh pr create`, `gh pr list`, `gh pr view`, `gh pr comment`, various `gh api` calls.

**Local dependencies**: `gh` CLI with local authentication, local git context for PR creation.

---

### 12. Deploy (Local Dev Server)

**What it does**: Starts a local dev server for a worktree — installs deps, copies `.env.local` files, spawns the server detached, and health-polls until ready.

**UI Components**: `DeployDialog`

**API Routes**:
| Route | Method | Purpose |
|-------|--------|---------|
| `/api/engineer/deploy` | POST | Install, spawn dev server, health poll |
| `/api/engineer/deploy/detect` | POST | Heuristic + LLM stack detection |
| `/api/engineer/deploy/status` | GET | Running server status |
| `/api/engineer/deploy/health` | GET | Poll dev server endpoint |
| `/api/engineer/deploy/kill` | POST | Kill dev server |
| `/api/engineer/deploy/teardown` | POST | Full teardown |
| `/api/engineer/deploy/check-existing` | GET | Check if already running |
| `/api/engineer/deploy/redetect` | POST | Re-run detection |
| `/api/engineer/deploy/extract-info` | POST | Extract config from project files |

**Shell commands spawned**: `pnpm install` / `npm install` (sync), `pnpm dev` / `next dev` etc. (detached).

**Local dependencies**: Installs dependencies, spawns dev server, copies `.env.local` files, health-polls localhost URLs, process management.

---

### 13. Learnings Pipeline

**What it does**: After Claude makes edits, asynchronously extracts "learnings" from chat history, processes them into `org-patterns.toon`, tracks usage.

**UI Components**: `LearningsDialog`, `LearningsUsedDialog`, `LearningsIndicator`

**API Routes**:
| Route | Method | Purpose |
|-------|--------|---------|
| `/api/engineer/symphony/extract-learnings` | POST | Trigger async extraction |
| `/api/engineer/symphony/process-learnings` | POST | Process into org patterns |
| `/api/engineer/symphony/record-learning-use` | POST | Record usage |
| `/api/engineer/symphony/learnings-status` | GET | Pipeline status |

**Shell commands spawned**: `claude -p --model sonnet --allowedTools=Read,Write,Glob,mcp__closedloop__* --max-turns 20`

**Local dependencies**: Spawns `claude` CLI, reads/writes learnings files at `~/.closedloop-ai/learnings/`.

---

### 15. Repo Management

**What it does**: CRUD for `~/.closedloop-ai/repos.json`.

**API Routes**:
| Route | Method | Purpose |
|-------|--------|---------|
| `/api/engineer/repos` | GET/POST/DELETE/PATCH | CRUD for repos config |

**Local dependencies**: Reads/writes JSON config file, reads `package.json` for heuristic detection.

---

### 16. Health Check

**What it does**: Checks availability of `git`, `claude`, `gh`, `codex`, `python3` and ClosedLoop plugin.

**API Routes**:
| Route | Method | Purpose |
|-------|--------|---------|
| `/api/engineer/health-check` | GET | Run all checks |

**Shell commands spawned**: `git --version`, `claude --version`, `gh --version`, `gh auth status`, `codex --version`, `python3 --version`

**Local dependencies**: All `--version` checks against locally installed tools.

---

### 17. Commit Message Generation

**What it does**: Auto-generates commit messages using Claude Haiku from git diff.

**API Routes**:
| Route | Method | Purpose |
|-------|--------|---------|
| `/api/engineer/symphony/commit-message/[ticketId]` | GET | Generate from diff |

**Shell commands spawned**: `git diff HEAD`, `claude --model haiku -p`

**Local dependencies**: Local git repo for diff, `claude` CLI.

---

### 18. Version & Update Checker

**What it does**: Shows current git version and checks for updates.

**UI Components**: `VersionBadge`, `UpdateBanner`

**API Routes**:
| Route | Method | Purpose |
|-------|--------|---------|
| `/api/engineer/version` | GET | `git rev-parse --short HEAD` + last 10 commits |

**Shell commands spawned**: `git rev-parse --short HEAD`, `git log -10`

**Local dependencies**: Runs git against the app's own repo.

---

### 19. File Search & Directory Browsing

**What it does**: Searches files in worktrees and browses directories for autocomplete.

**API Routes**:
| Route | Method | Purpose |
|-------|--------|---------|
| `/api/engineer/files/search` | GET/POST | Search files via glob |
| `/api/engineer/directories` | GET | List directories |

**Local dependencies**: `readdir`, `existsSync`, glob traversal of local filesystem.

---

## Remote Deployability — Original Assessment

Without any relay mechanism, the vast majority of features are local-only:

| # | Feature | Remote? | Reason if Local-Only |
|---|---------|---------|---------------------|
| 1 | Dashboard & Tickets | NO | Work-dir checks require local filesystem. |
| 2 | ClosedLoop Launch | NO | Spawns `run-loop.sh`, creates worktrees, process management |
| 3 | ClosedLoop Chat | NO | Spawns `claude` CLI, local worktree |
| 4 | Codex Review | NO | Spawns `codex`/`claude` CLI, local git |
| 5 | Codex Debate | NO | Spawns both `codex` and `claude` CLI |
| 6 | PR Comment Chat | NO | Spawns `claude` CLI, local worktree |
| 7 | Terminal Chat | NO | Spawns `claude`/`codex` CLI |
| 8 | Ticket Chat | NO | Spawns `claude` CLI |
| 9 | Run Viewer Chat | NO | Spawns `claude` CLI, local `/tmp/` |
| 10 | Git Operations | NO | Local git repos, worktree management |
| 11 | PR Management | PARTIAL | `gh` CLI needs local auth + git context |
| 12 | Deploy | NO | Local dev server process |
| 13 | Learnings | NO | Spawns `claude` CLI, local files |
| 15 | Repo Management | NO | Local config file |
| 16 | Health Check | NO | Local CLI tool checks |
| 17 | Commit Message | NO | Local git + `claude` CLI |
| 18 | Version/Update | PARTIAL | Git-specific deployment model |
| 19 | File Search/Dirs | NO | Local filesystem |

**Score: 0/18 fully remote, 3/18 partial, 15/18 local-only.**

---

## Remote Deployability — With Electron Shell Relay

### The Model

An Electron app runs on the user's laptop and establishes a persistent connection (WebSocket) to the remote web server. The server sends commands; the Electron app presents each to the user for approval, executes approved commands locally, and streams results back.

This fundamentally changes the equation: the web server no longer needs local access — it delegates to the user's machine via the relay.

### Relay Primitive Catalog

Based on the route-by-route analysis, the Electron relay needs these primitives:

| Primitive | Description | Used By |
|-----------|-------------|---------|
| **`exec`** | Run command, return `{ stdout, stderr, exitCode }` | git, gh, version checks, health check |
| **`spawn_stream`** | Spawn process, stream stdout line-by-line back to server in real-time | All chat routes (claude/codex CLI) |
| **`spawn_detached`** | Spawn process detached, return `{ pid }` immediately. stdout/stderr → local log file | symphony/launch, deploy |
| **`kill`** | Send signal to PID or process group (`-pid`) | symphony/kill, deploy/kill, cancel handlers |
| **`is_alive`** | Signal-0 liveness check, return boolean | symphony/status, symphony/kill |
| **`read_file`** | Read file contents from path | state.json, plan.json, chat-history.json, etc. |
| **`write_file`** | Write content to path | chat-history.json, prd.md, state.json, etc. |
| **`delete_file`** | Delete file at path | PID files, state files, worktree cleanup |
| **`read_dir`** | List directory contents | .agent-types/, directories, file search |
| **`exists`** | Check if path exists | worktree checks, .git checks |
| **`stat`** | Get file metadata (mtime) | state.json staleness detection |
| **`glob`** | Find files matching pattern | file search, plugin path discovery |
| **`mkdir`** | Create directory (recursive) | worktree work dirs, attachment dirs |
| **`stdin_write`** | Write to a spawned process's stdin then close | Claude CLI prompt delivery |

### Per-Feature Relay Assessment

#### 1. Dashboard & Ticket Management
**Via relay?** YES

The `work-directory` route needs: `exec` (git commands), `read_file` (sessions.json, repos.json), `exists` (worktree paths, CLAUDE.md). All expressible as relay primitives.

**Relay operations per poll**: ~4 `exec` calls (git status, rev-parse, ls-remote, branch --merged) + 2 `read_file` + 1 `exists` per ticket.

---

#### 2. ClosedLoop Launch & Orchestration
**Via relay?** YES

- **Launch**: `exec` (git branch, worktree add, fetch), `write_file` (prd.md, attachments), `spawn_detached` (run-loop.sh → returns PID), `write_file` (process.pid)
- **Status**: `read_file` (state.json, plan.json, process.pid, launch.log), `is_alive` (PID check), `read_dir` (.agent-types/), `stat` (state.json mtime), `exists` (.learnings/.lock)
- **Kill**: `read_file` (process.pid), `delete_file` (state file, PID file), `kill` (-pid SIGTERM, then -pid SIGKILL), `is_alive`, `write_file` (state.json update), `read_dir` + `delete_file` (.agent-types/ cleanup)
- **Sessions**: `read_file` + `write_file` (sessions.json)

**Complexity**: Medium. The `kill` primitive must support **negative PIDs** (process group semantics). This is the most unusual requirement.

---

#### 3. ClosedLoop Chat
**Via relay?** YES

- **Chat POST**: `read_file` (chat-history.json, plan.json, prd.md, org-patterns.toon), `spawn_stream` (claude CLI with stdin prompt → stream stdout NDJSON back), `write_file` (chat-history.json with session ID + messages), `kill` (SIGTERM on cancel)
- **Kill timer**: The relay must implement the 30s-SIGTERM/5s-SIGKILL timer after receiving a `result` event. This can live server-side (server tells relay to `kill` after timeout) or client-side in the Electron app.

**Complexity**: High. This is the core streaming use case. The relay must:
1. Write prompt to process stdin, then close stdin
2. Stream stdout line-by-line back to server in real-time (low latency critical)
3. The server parses NDJSON, transforms events, and re-streams to browser
4. On browser disconnect → server tells relay to SIGTERM
5. Session ID must be persisted locally before acknowledging upstream (ordering constraint)

---

#### 4. Codex Review
**Via relay?** YES — but most complex

- **Review POST**: `exec` (git rev-parse, merge-base, checkout, apply) + `exec` (gh pr diff, gh pr view) + `write_file` (temp .patch file) + `delete_file` (.patch) + `spawn_stream` or `spawn_detached` (codex/claude, detached with log appending) + `write_file` (review state, log, PID, codex-chat.json)
- **Status GET**: `read_file` (review state JSON + log file, last 100KB)
- **Stop**: `kill` (SIGTERM + SIGKILL), `write_file` (state update)

**Complexity**: Very high. This route uses 8+ distinct shell commands in sequence, writes temporary files, and uses both streaming and detached process patterns. The detached review process continues running and appending to a log file after the HTTP response ends — the relay must keep it alive independently.

---

#### 5. Codex Debate
**Via relay?** YES

- `read_file` (codex-debate.json), `spawn_stream` (codex exec), `write_file` (codex-debate.json with session ID)
- Stale session retry: if process exits with error matching pattern → `write_file` (clear session), re-`spawn_stream` (fresh args)

**Complexity**: Medium. The auto-retry on stale sessions means the relay orchestration needs to handle "spawn failed, clear state, spawn again" as a compound operation.

---

#### 6. PR Comment Chat
**Via relay?** YES

Same pattern as ClosedLoop Chat (#3) plus: `exec` (git worktree list, git worktree add for PR worktree resolution), `read_file`/`write_file` (comment chat JSON).

**Complexity**: Medium-High. The worktree resolution step (find or create a worktree for a PR) adds multi-step `exec` sequences before the streaming spawn.

---

#### 7. Terminal Chat
**Via relay?** YES

Same streaming pattern as #3 but with `cwd: homedir()`. Additional: `exec` (git remote get-url, git rev-parse per repo for context), `read_file` (CLAUDE.md per repo, org-patterns.toon, chat history).

**Complexity**: Medium. Dual-mode (Claude or Codex) but same primitives.

---

#### 8. Ticket Chat
**Via relay?** YES

Simplest streaming chat: `read_file` (chat history), `spawn_stream` (claude CLI), `write_file` (chat history).

**Complexity**: Low-Medium. Straightforward streaming spawn.

---

#### 9. Run Viewer Chat
**Via relay?** YES

Same as Ticket Chat but reads from `/tmp/run-viewer-*` paths. The run artifacts would need to exist on the user's machine (they're extracted from downloaded zips).

**Complexity**: Low-Medium.

---

#### 10. Git Operations
**Via relay?** YES

- All `simple-git` operations → translate to `exec` (git commands)
- Conflict resolution → `spawn_stream` (claude CLI, with 180s timeout kill)

**Complexity**: Medium. The `simple-git` library wraps git commands — these would need to be decomposed into raw `exec` calls. Or the relay could expose a `simple-git`-compatible interface.

---

#### 11. PR Management
**Via relay?** YES

All routes are `exec` (gh CLI commands). No streaming, no file I/O.

**Complexity**: Low. Pure command execution with JSON output.

---

#### 12. Deploy (Local Dev Server)
**Via relay?** YES — but UX changes needed

- **Deploy POST**: `exec` (install command, sync, blocking), `spawn_detached` (dev server), health poll loop
- **Health**: The server currently polls the dev server's localhost URL — with a relay, the dev server runs on the user's machine, so health checks must either go through the relay or the Electron app must expose a port-forward/tunnel.
- **Kill**: `kill` (PID SIGTERM/SIGKILL)

**Complexity**: High. The dev server is accessible only on the user's localhost. The remote web server can't health-check it directly. Options:
1. Relay proxies health check requests
2. Electron app runs health checks locally and reports status
3. Tunnel (e.g., ngrok-style) to expose the dev server

---

#### 13. Learnings Pipeline
**Via relay?** YES

- `spawn_detached` (claude CLI for extraction), `read_file`/`write_file` (learnings files at `~/.closedloop-ai/learnings/`)

**Complexity**: Low. Fire-and-forget CLI spawn + file I/O.

---

#### 15. Repo Management
**Via relay?** YES

- `read_file`/`write_file` (repos.json), `read_file` (package.json for detection), `exists` (path checks)

**Complexity**: Low. Pure file I/O.

---

#### 16. Health Check
**Via relay?** YES

- `exec` for each tool (git, claude, gh, codex, python3 `--version` checks)
- `read_file` (repos.json), `glob` (plugin path discovery)

**Complexity**: Low. ~6 independent `exec` calls.

---

#### 17. Commit Message Generation
**Via relay?** YES

- `exec` (git diff HEAD), `spawn_stream` or `exec` (claude --model haiku, short-lived)

**Complexity**: Low.

---

#### 18. Version & Update Checker
**Via relay?** YES

- `exec` (git rev-parse, git log)

**Complexity**: Trivial. Two git commands.

---

#### 19. File Search & Directory Browsing
**Via relay?** YES

- `glob` (file search), `read_dir` + `exists` (directory browsing)

**Complexity**: Low. Pure filesystem queries.

---

### Relay Feasibility Summary

| # | Feature | Via Relay? | Complexity | Key Challenges |
|---|---------|-----------|------------|----------------|
| 1 | Dashboard & Tickets | **YES** | Low | Multiple git exec calls per ticket |
| 2 | ClosedLoop Launch | **YES** | Medium | Process group kill needs -pid support |
| 3 | ClosedLoop Chat | **YES** | High | Real-time stdout streaming, kill timers, session ID ordering |
| 4 | Codex Review | **YES** | Very High | 8+ shell commands, detached+streaming, temp files, log appending |
| 5 | Codex Debate | **YES** | Medium | Stale session auto-retry logic |
| 6 | PR Comment Chat | **YES** | Medium-High | Worktree resolution + streaming |
| 7 | Terminal Chat | **YES** | Medium | Dual-mode (Claude/Codex) |
| 8 | Ticket Chat | **YES** | Low-Medium | Standard streaming |
| 9 | Run Viewer Chat | **YES** | Low-Medium | Standard streaming + /tmp files |
| 10 | Git Operations | **YES** | Medium | simple-git decomposition, conflict resolution |
| 11 | PR Management | **YES** | Low | Pure gh CLI exec |
| 12 | Deploy | **YES*** | High | Dev server only reachable on user's localhost |
| 13 | Learnings | **YES** | Low | Fire-and-forget spawn + file I/O |
| 15 | Repo Management | **YES** | Low | Pure file I/O |
| 16 | Health Check | **YES** | Low | Batch exec calls |
| 17 | Commit Message | **YES** | Low | exec + short spawn |
| 18 | Version/Update | **YES** | Trivial | Two git commands |
| 19 | File Search/Dirs | **YES** | Low | Filesystem queries |

### Result: **18/18 local features become remotely feasible** via the Electron relay.

The only feature with a meaningful caveat is **Deploy** (#12) — the dev server runs on the user's machine and its health-check URL isn't reachable from the remote server. This requires either a tunnel or relay-proxied health checks.

---

### Relay Architecture Sketch

```
┌─────────────────────────────────────────────────────────┐
│  Remote Web Server (apps/app on cloud)                  │
│                                                         │
│  /api/engineer/* routes                                 │
│     │                                                   │
│     │ Instead of child_process.spawn/exec,              │
│     │ calls RelayClient.exec() / .spawnStream() etc.    │
│     │                                                   │
│     └───── WebSocket ──────────────────────┐            │
│                                            │            │
└────────────────────────────────────────────│────────────┘
                                             │
                                        Internet
                                             │
┌────────────────────────────────────────────│────────────┐
│  Electron App (user's laptop)              │            │
│                                            │            │
│     ┌── RelayServer ◄─────────────────────┘            │
│     │                                                   │
│     │   Receives commands, shows approval UI            │
│     │                                                   │
│     ├── exec(cmd, args)                                 │
│     │     → child_process.execFile()                    │
│     │     → return { stdout, stderr, exitCode }         │
│     │                                                   │
│     ├── spawnStream(cmd, args, stdin?)                  │
│     │     → child_process.spawn()                       │
│     │     → write stdin, close                          │
│     │     → stream stdout lines over WebSocket          │
│     │     → handle cancel → SIGTERM                     │
│     │                                                   │
│     ├── spawnDetached(cmd, args, logFile)               │
│     │     → spawn({ detached: true })                   │
│     │     → child.unref()                               │
│     │     → return { pid }                              │
│     │                                                   │
│     ├── kill(pid, signal)    // supports -pid           │
│     ├── isAlive(pid)         // signal 0                │
│     ├── readFile(path)                                  │
│     ├── writeFile(path, content)                        │
│     ├── deleteFile(path)                                │
│     ├── readDir(path)                                   │
│     ├── exists(path)                                    │
│     ├── stat(path)                                      │
│     ├── glob(pattern, cwd)                              │
│     └── mkdir(path, { recursive })                      │
│                                                         │
│  ┌───────────────────────────────────────┐              │
│  │  Approval UI                          │              │
│  │  "Server wants to run:                │              │
│  │   claude -p --model opus ...          │              │
│  │   [Approve] [Deny] [Always Allow]"    │              │
│  └───────────────────────────────────────┘              │
│                                                         │
│  Local resources: git repos, ~/.closedloop-ai/,         │
│  claude CLI, codex CLI, gh CLI, git                     │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Refactoring Scope

The API route handlers in `apps/app/app/api/engineer/` currently call Node.js `child_process` and `fs` directly. To support the relay, each route would need to be refactored to use an abstraction layer:

```typescript
// Current (direct):
const child = spawn("claude", args, { cwd });
const content = readFileSync(path, "utf-8");

// Refactored (relay-compatible):
const child = await relay.spawnStream("claude", args, { cwd });
const content = await relay.readFile(path);
```

The abstraction layer would have two implementations:
1. **LocalBackend** — wraps `child_process` and `fs` directly (current behavior)
2. **RelayBackend** — sends commands over WebSocket to the Electron app

This means **no changes to the UI layer or hooks** — only the API route implementations need the abstraction.

---

### Challenges & Risks

#### 1. Latency
Every filesystem read and shell command now has a network round-trip. Status polling (every 2-3s) that reads 6+ files per poll will feel the added latency. Mitigation: batch relay operations (send multiple reads in one message), or push status updates from Electron instead of polling.

#### 2. Streaming Fidelity
The NDJSON streaming pattern requires low-latency, ordered delivery of stdout lines. WebSocket provides this, but any buffering or congestion could introduce visible lag in the chat UI. Mitigation: WebSocket binary frames with minimal framing overhead.

#### 3. Process Group Kill Semantics
The `kill(-pid, "SIGTERM")` call uses POSIX process group semantics (negative PID = kill the entire process group). The Electron app must faithfully replicate this — a simple `child.kill()` is not sufficient. Mitigation: Electron uses `process.kill(-pid, signal)` directly (Node.js supports this on macOS/Linux).

#### 4. Detached Process Lifecycle
Detached processes (symphony/launch, deploy) survive the relay connection. If the WebSocket drops and reconnects, the Electron app must still track orphaned PIDs. Mitigation: PID file persistence (already exists), reconnection protocol that syncs known PIDs.

#### 5. Session ID Ordering
The `onSessionId` callback fires synchronously during stdout parsing. The relay must persist the session ID to disk *before* acknowledging it upstream, or a disconnect between `init` and `result` events loses the session forever. Mitigation: relay-side write-before-ack protocol.

#### 6. User Approval UX
If every command requires manual approval, the experience will be painfully slow — a single ClosedLoop chat turn may invoke dozens of tool calls internally. Mitigation: approval categories ("Always allow `claude` CLI", "Always allow `git` in this repo"), session-level blanket approvals, or risk-tiered approval (auto-approve reads, prompt for writes/spawns).

#### 7. Deploy Health Check
The dev server runs on `localhost:3000` on the user's machine. The remote server can't reach it. Mitigation options:
- Electron app runs health checks locally and reports via relay
- Expose a tunnel (ngrok-style) for the remote server to reach
- Deploy feature only works in "local preview" mode (user views it in their browser directly)

#### 8. Security
The relay essentially provides remote code execution on the user's machine. The WebSocket connection must be:
- Authenticated (tied to the user's Clerk session)
- Encrypted (WSS only)
- Origin-validated
- Rate-limited
- The Electron app should show a persistent indicator when the relay is active

---

## Remote Deployability — With Plugin-Based High-Level Operations

### Why High-Level Operations Win

The low-level relay approach (Section 6) works but is chatty — a single ClosedLoop chat turn requires ~8 filesystem reads, a process spawn, stdin write, stdout streaming, a kill timer, and a file write, each as a separate round-trip. The investigation revealed a critical insight:

**Every single engineer API route has ZERO server-side dependencies.** No database access. No cloud API calls. No Clerk auth (except one route that can be dropped). The server inputs are just user messages, ticket data (already in the browser from the API), model configs, and IDs/paths.

This means the entire orchestration logic currently in `apps/app/app/api/engineer/` can move wholesale into the Claude Code plugin on the user's machine. The server becomes a thin pass-through: it receives a user action from the browser, sends a single high-level command to the Electron app, and the plugin handler does everything locally.

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Remote Web Server (apps/app on cloud)                          │
│                                                                 │
│  Browser ─── React UI (unchanged) ───> /api/engineer/*          │
│                                         │                       │
│                        Thin route: validate input,              │
│                        forward to Electron, relay response      │
│                                         │                       │
│                                    WebSocket                    │
└─────────────────────────────────────────│───────────────────────┘
                                          │
                                     Internet
                                          │
┌─────────────────────────────────────────│───────────────────────┐
│  Electron App (user's laptop)           │                       │
│                                         │                       │
│  ┌─ Relay Transport ◄──────────────────┘                       │
│  │  Receives high-level ops, shows approval UI                  │
│  │                                                              │
│  └─> Plugin Handler Router                                      │
│       │                                                         │
│       ├─ ~/.claude/plugins/cache/closedloop-ai/                 │
│       │   └── operations/                                       │
│       │       ├── symphony_launch.ts                            │
│       │       ├── symphony_chat.ts                              │
│       │       ├── symphony_kill.ts                              │
│       │       ├── codex_review.ts                               │
│       │       ├── git_action.ts                                 │
│       │       ├── ...                                           │
│       │       └── (current route handler logic, moved here)     │
│       │                                                         │
│       ├─ Shared libs (also from plugin):                        │
│       │   ├── stream-events.ts                                  │
│       │   ├── repos.ts                                          │
│       │   ├── learnings.ts                                      │
│       │   └── allowed-tools.ts                                  │
│       │                                                         │
│       └─ Local resources:                                       │
│           ├── claude, codex, git, gh CLIs                       │
│           ├── ~/.closedloop-ai/repos.json                       │
│           ├── ~/Source/* (git repos + worktrees)                │
│           └── ~/.closedloop-ai/learnings/                       │
│                                                                 │
│  ┌─ Approval UI ──────────────────────────────────────┐        │
│  │  "ClosedLoop Chat for AI-350"         [Allow] [Deny] │        │
│  │  "Create PR: Fix auth bug"    [Allow] [Always Allow]│        │
│  └─────────────────────────────────────────────────────┘        │
└─────────────────────────────────────────────────────────────────┘
```

### Execution Model: Multi-Tool, Not Claude-Specific

The relay is a **general-purpose local execution engine**, not a "Claude runner." It must handle 7 distinct CLI tools, each with different spawn patterns, output formats, and lifecycle management:

| Tool | Spawn Pattern | Output Format | Lifecycle | Used By |
|------|--------------|---------------|-----------|---------|
| **`claude` CLI** | Streaming (stdin→stdout pipe) | NDJSON (`stream-json`) | Kill timer: 30s SIGTERM + 5s SIGKILL after `result` event | symphony_chat, comment_chat, terminal_chat, ticket_chat, codex_review (Claude provider), commit_message, learnings, conflict resolution |
| **`codex` CLI** | Streaming (stdout pipe) | JSONL (`thread.started`, `item.completed`) | Stale session auto-retry; no explicit kill timer | codex_review (Codex provider), codex_argue, codex_chat, terminal_chat (@codex mode) |
| **`git` CLI** | One-shot exec (return stdout) | Plain text or structured output | Sync — blocks until done | symphony_launch, git_action, git_pr, work_directory, branches, diff, worktree, codex_review (merge-base, checkout, apply) |
| **`gh` CLI** | One-shot exec (return stdout) | JSON (via `--json` flag) or plain text | Sync — blocks until done | git_pr (create, list, comments, reviews, reply, files), codex_review (pr diff, pr view), git_user |
| **`run-loop.sh`** | Detached (stdout→log file) | Writes state.json, plan.json as side-effects | Fire-and-forget; tracked via PID file; killed via process group (`-pid`) | symphony_launch |
| **Dev server** (`pnpm dev`, etc.) | Detached (stdout→log file) | None (health-polled via HTTP) | Fire-and-forget; tracked via PID; killed via PID | deploy |
| **`python3`** | One-shot exec | Version string | Health check only | health_check |

Each high-level operation handler in the plugin knows exactly which tools to orchestrate and in what order. For example, `codex_review` may run:
1. `git rev-parse HEAD` (exec)
2. `git merge-base HEAD origin/main` (exec)
3. `gh pr diff 123` (exec)
4. `git checkout --detach <base>` (exec)
5. `git apply <patch>` (exec)
6. `codex review --uncommitted` (streaming, detached)

The server never sees these 6 commands — it just says `{ operation: "codex_review", params: { ticketId, model, provider, ... } }`.

### Operation Catalog

17 high-level operations replace ~70+ API routes:

#### ClosedLoop Operations

| Operation | Current Route(s) | Server → Electron Input | Electron → Server Output |
|-----------|-----------------|------------------------|--------------------------|
| `symphony_launch` | `symphony/launch` POST | `{ ticketIdentifier, repoPath, ticket: { title, description, url, context, mentionedFiles[] }, baseBranch? }` | `{ success, pid, workDir, logFile, baseBranch }` |
| `symphony_status` | `symphony/status/[ticketId]` GET | `{ ticketId, repoPath }` | `{ exists, status, phase, pid, processRunning, taskProgress, activeAgents[], planExists }` |
| `symphony_kill` | `symphony/kill` POST | `{ pid }` or `{ ticketId, repoPath }` | `{ success, pid }` |
| `symphony_chat` | `symphony/chat/[ticketId]` POST, `symphony/chat-history` GET/DELETE | `{ ticketId, repoPath, message, activeTab?, contextRepoPaths?, codexReview?, codexAvailable? }` | **Stream**: `status → text → tool_use → tool_result → thinking → usage → learnings → done` |
| `symphony_comment_chat` | `symphony/comment-chat/[commentId]` GET/POST/DELETE/PATCH | `{ commentId, ticketId, repoPath, message, commentContext: { author, body, path, line, url, replies[] }, branchName?, prNumber? }` | **Stream**: same as chat + `worktree_resolved` event |
| `symphony_commit_message` | `symphony/commit-message/[ticketId]` GET | `{ ticketId, repoPath }` | `{ title, description }` |
| `symphony_sessions` | `symphony/sessions` GET/POST/DELETE | `{ action, ticketId?, session? }` | `{ sessions[] }` |

#### Chat Operations

| Operation | Current Route(s) | Server → Electron Input | Electron → Server Output |
|-----------|-----------------|------------------------|--------------------------|
| `terminal_chat` | `terminal-chat` GET/POST/DELETE | `{ message }` or `{ action: "get"\|"delete" }` | **Stream** or `{ messages[] }` |
| `ticket_chat` | `ticket-chat` GET/POST/DELETE | `{ ticketId, message, ticketContext: { identifier, title, description, url }, repoPath? }` | **Stream** or `{ messages[] }` |
| `run_viewer_chat` | `run-viewer-chat` GET/POST/DELETE | `{ runDir, message }` | **Stream** or `{ messages[] }` |

#### Code Review Operations

| Operation | Current Route(s) | Server → Electron Input | Electron → Server Output |
|-----------|-----------------|------------------------|--------------------------|
| `codex_review` | `codex/review/[ticketId]` POST, `codex/status` GET/DELETE, `codex/stop` POST, `codex/available` GET | `{ ticketId, repoPath, model, provider, reviewMode, baseBranch?, instructions? }` | **Stream**: `sessionId → output → usage → done` |
| `codex_argue` | `codex/argue/[ticketId]` POST, `codex/chat/[ticketId]` POST | `{ ticketId, repoPath, claudeArgument, findingSummary, debateHistory[], model }` | **Stream**: `reasoning → text → done` (with `debateStatus`) |

#### Git Operations

| Operation | Current Route(s) | Server → Electron Input | Electron → Server Output |
|-----------|-----------------|------------------------|--------------------------|
| `git_action` | `git` POST, `git/branches` GET, `git/diff` POST, `git/worktree` DELETE/POST | `{ action, repoPath, branchName?, message?, baseBranch?, file?, ... }` | Action-specific JSON |
| `git_pr` | `git/pr/*` (8 sub-routes) | `{ action, repoPath, title?, body?, prNumber?, ... }` | Action-specific JSON |

#### Infrastructure Operations

| Operation | Current Route(s) | Server → Electron Input | Electron → Server Output |
|-----------|-----------------|------------------------|--------------------------|
| `health_check` | `health-check` GET | `{}` (no input) | `{ checks[], allRequiredPassed }` |
| `repos_config` | `repos` GET/POST/DELETE/PATCH | `{ action, path?, settings? }` | `{ repos[], settings }` |
| `deploy` | `deploy/*` (9 sub-routes) | `{ action, ticketId?, repoPath?, worktreePath? }` | Action-specific JSON |
| `learnings` | `extract-learnings`, `process-learnings`, `learnings-status`, `record-learning-use` | `{ action, ticketId?, repoPath? }` | `{ status }` |
| `filesystem` | `files/search`, `directories`, `work-directory/[ticketId]` | `{ action, path?, query?, ticketId? }` | Action-specific JSON |

### What Crosses the Wire

The data that flows from the remote server to the Electron app is remarkably small:

**Server → Electron (commands):**
- User's chat messages (plain text, < 10KB)
- Ticket metadata (title, description, URL — already in the browser from the API)
- Model/config preferences (string enums)
- IDs and paths (strings)
- PR comment context from GitHub (already fetched by the browser)
- Debate history for Codex argue (array of messages, maintained browser-side)

**Electron → Server (responses):**
- For chat operations: stream of NDJSON events (same `stream-events.ts` format, unchanged)
- For status/git/config operations: single JSON response objects
- For review operations: stream of output events

**Nothing needs to change in the React UI or hooks.** The browser still calls `/api/engineer/*` on the remote server. The server routes become thin pass-throughs that forward to the Electron app and relay the response/stream back. The `useChatStream` hook, `readChatStream()` parser, and all TanStack Query options remain identical. Note: Claude CLI continues to use MCP independently for its own tool calls — this is unaffected by the relay architecture.

### What Stays Entirely Local

Everything below the relay transport stays on the user's machine:

- All `child_process.spawn/exec` calls (claude, codex, git, gh CLIs)
- All `fs` operations (read/write chat history, state.json, plan.json, repos.json, learnings)
- All process management (PIDs, signal-0 checks, SIGTERM/SIGKILL, process groups)
- All git worktree creation/deletion
- Session ID persistence and resume logic
- Kill timers (30s SIGTERM + 5s SIGKILL after result event)
- Org-patterns and learnings pipeline
- `.env.local` copying for deploy
- Dev server lifecycle

### Streaming Protocol

For the 7 streaming operations (all chat + review + argue), the Electron handler emits the exact same NDJSON event format that the current API routes emit. The only change is transport:

```
Current:  Browser ──HTTP SSE──> Next.js route ──stdout pipe──> claude CLI
Proposed: Browser ──HTTP SSE──> Server ──WebSocket──> Electron ──stdout pipe──> claude CLI
```

The server's thin route handler creates a `ReadableStream` that reads from the WebSocket and writes to the HTTP response. From the browser's perspective, the stream looks identical.

```typescript
// Current route handler (simplified):
export async function POST(request: Request) {
  const { message, ticketId, repoPath } = await request.json();
  const stream = new ReadableStream({
    start(controller) {
      const claude = spawn("claude", ["-p", ...args], { cwd: worktreeDir });
      claude.stdout.on("data", chunk => controller.enqueue(chunk));
      claude.on("close", () => controller.close());
    }
  });
  return new Response(stream);
}

// Proposed thin route handler:
export async function POST(request: Request) {
  const body = await request.json();
  const stream = relay.streamOperation("symphony_chat", body);
  //    ^^^^^ opens WebSocket channel, returns ReadableStream of events
  return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
}
```

### Approval UX

With high-level operations, the approval UI becomes natural and user-friendly:

| Operation | Approval Prompt | Risk Level |
|-----------|----------------|------------|
| `symphony_launch` | "Launch ClosedLoop for **AI-350** in **my-repo**?" | Medium (creates worktree, spawns process) |
| `symphony_chat` | "Send message to Claude in **AI-350**?" | Low (within existing session) |
| `symphony_kill` | "Stop ClosedLoop for **AI-350**?" | Low (user-initiated) |
| `codex_review` | "Run code review on **AI-350** with **Claude**?" | Low (read-only analysis) |
| `git_action:push` | "Push branch **ai-350-fix-auth** to origin?" | Medium (visible to team) |
| `git_pr` | "Create PR: **Fix auth bug in login flow**?" | Medium (visible to team) |
| `deploy` | "Start dev server for **AI-350**?" | Low (local only) |

**Auto-approval tiers:**
- **Always auto-approve**: `symphony_status`, `health_check`, `repos_config` (read), `filesystem` (read-only queries)
- **Auto-approve per session**: `symphony_chat` (after first approval for that ticket), `terminal_chat`, `ticket_chat`
- **Always prompt**: `symphony_launch`, `git_action:push`, `git_pr`, `deploy`

### Remaining Challenges

#### 1. Plugin Update Distribution
Operation handlers live in the plugin (`~/.claude/plugins/cache/closedloop-ai/`). When you update handler logic, users get it on next plugin sync -- no server redeploy needed. But you need a versioning/compatibility protocol: the server must know which operation versions the Electron app supports.

**Mitigation**: Handshake on WebSocket connect — Electron reports `{ pluginVersion: "0.4.2", operations: ["symphony_chat@v2", "codex_review@v3", ...] }`.

#### 2. Streaming Latency
An extra network hop (server ↔ Electron) adds latency to every streamed token. For chat, this means visible typing lag.

**Mitigation**: The Electron app could expose a direct WebSocket to the browser (bypassing the server for streaming), with the server only involved in auth and operation dispatch. Or use WebSocket binary frames with minimal overhead.

#### 3. Connection Reliability
If the WebSocket drops mid-stream, the Claude process is still running on the user's machine. Reconnection needs to:
- Resume streaming from where it left off (buffer events in Electron)
- Sync PID state for running processes
- Not duplicate chat history entries

**Mitigation**: Each operation gets a unique `operationId`. On reconnect, Electron replays buffered events for in-flight operations. PID files on disk serve as the source of truth for process state (already the pattern today).

#### 4. The `auth()` Exception
The `git` POST route is the only one calling Clerk `auth()`. In the Electron model, this is unnecessary — the user already authenticated to the remote server (which dispatched the command), and the Electron app runs as the user on their own machine. Drop the check.

#### 5. Deploy Health Checks
The dev server runs on `localhost:XXXX` on the user's machine. The remote server can't reach it. In the high-level operation model, this is cleanly solved: the `deploy` operation handler runs the health poll loop locally and reports status back via the WebSocket. The browser polls the server, the server asks Electron, Electron checks localhost. No tunnel needed.

#### 6. Image Downloads in Launch
`symphony_launch` downloads images from ticket descriptions (Linear URLs) and saves them locally. The Electron app needs internet access for this (it already has it), but the URLs come from the server as part of the ticket data. No issue.

### Feasibility Assessment

#### Prior Art Validation

**Claude Code Remote Control** (shipped Feb 24, 2026) uses exactly this architecture: outbound WebSocket from the user's machine to Anthropic's relay API, browser connects from the other side, local files/credentials never leave the machine. This validates the pattern at production scale.

Additional prior art: `chadbyte/claude-relay` (npm), `gvorwaller/claude-relay` (MCP server), VS Code tunnels (`code tunnel`), Coder workspace agents.

#### Recommended Implementation: Node.js CLI

A pure Node.js CLI (`npx symphony-relay` or installed via the Claude Code plugin) is recommended over Electron:

| Factor | Node.js CLI | Electron |
|--------|------------|----------|
| Distribution | `npx` — zero friction | DMG/MSI/AppImage + code signing |
| Binary size | ~0 MB (uses system Node) | ~85 MB (bundles Chromium) |
| Approval UX | Terminal `y/N` prompt | Native GUI window |
| Code signing | Not needed | $99/yr Apple + $300-500/yr Windows |
| LLM buildability | Very high | High (but signing/packaging is manual) |
| Language | TypeScript (same as monorepo) | TypeScript + framework overhead |
| Auto-update | `npm update` | electron-updater |

#### Effort Estimates

**Node.js CLI approach:**

| Phase | Effort | Scope |
|-------|--------|-------|
| MVP (macOS) | **3-4 weeks** | WebSocket relay + terminal approval + `symphony_chat`, `symphony_launch`, `symphony_kill`, `symphony_status`, `git_action` |
| Full parity | **7-8 weeks** | All 17 operations including `codex_review` (most complex), `codex_argue`, deploy, learnings |
| Cross-platform | **+2-3 weeks** | Windows (WSL required for `run-loop.sh`) + Linux |

**If Electron is required later** (for GUI approval, tray icon, notifications): +4-5 weeks to wrap the CLI core in Electron. The relay logic doesn't change — only the transport and approval UI.

#### LLM Buildability

An LLM can produce ~70-80% of working code. The 20-30% requiring human debugging:

1. **Streaming reconnect protocol** — mid-stream WebSocket drop + resume + event replay (3-5 days)
2. **Session ID ordering** — write-before-ack constraint (subtle, 1-2 iterations)
3. **Node.js stdout buffering** — 8KB highWaterMark causes token bursting (LLM likely misses this)
4. **Windows WSL/bash detection** — registry reads, distro detection (partially correct from LLM)
5. **Code signing** (Electron only) — procurement, not coding

#### Cross-Platform Considerations

| Platform | Status | Notes |
|----------|--------|-------|
| macOS | Full support | All CLIs available natively |
| Linux | Full support | All CLIs available natively |
| Windows | Requires WSL | `run-loop.sh` is bash; `process.kill(-pid)` needs `tree-kill` package; paths need `os.homedir()` + `path.join()` |

The relay itself is ~80% platform-agnostic Node.js. ~15-20% needs platform-specific handling (process kill, path resolution, bash detection).

---

## Phase 6: Desktop Client for Non-Engineers

### Audience Shift

The previous sections assumed the user is an engineer running a terminal. Phase 6 re-evaluates everything for a broader audience: **PMs, designers, and non-engineers** who need to fire up their laptop, establish a server connection, and have visibility into AI jobs running on their machine — without ever touching a terminal.

This changes the product from a "CLI relay" to a **remote compute platform with a native desktop client**.

### Why Electron (Not CLI, Not Tauri)

| Factor | Node.js CLI | Electron | Tauri |
|--------|------------|----------|-------|
| Non-engineer UX | Terminal prompts — hostile | Native GUI, tray icon, notifications | Native GUI, smaller binary |
| System tray | Not possible | Built-in (`Tray` API) | Built-in |
| OAuth login | Manual token paste | System browser → deep link → `safeStorage` | Same as Electron |
| Approval UX | `y/N` in terminal | Visual queue with context, risk badges | Same as Electron |
| Notifications | None | OS-native via Electron API | OS-native |
| LLM docs coverage | N/A | Excellent — 10+ years of community docs | Moderate — Rust backend, less LLM training data |
| Binary size | ~0 MB | ~85 MB | ~10-15 MB |
| Language | TypeScript | TypeScript (renderer + main) | Rust (backend) + TypeScript (frontend) |

**Decision**: Electron. The audience can't use a terminal. Tauri's Rust backend adds friction for LLM-driven development. The 85 MB binary cost is acceptable for a desktop app.

### Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  Electron Main Process                                               │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  ConnectionManager                                           │    │
│  │  • WSS connection to symphony server                         │    │
│  │  • Auto-reconnect with exponential backoff (1s→30s cap)      │    │
│  │  • Heartbeat (30s ping/pong)                                 │    │
│  │  • Event buffering during disconnect                         │    │
│  │  • Operation resume on reconnect                             │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  ProcessManager                                              │    │
│  │  • Tracks all spawned processes (Map<operationId, Process>)  │    │
│  │  • Implements spawn patterns: exec, stream, detached          │    │
│  │  • Kill timer: 30s SIGTERM + 5s SIGKILL (configurable)       │    │
│  │  • Process group kill via -pid (POSIX) / tree-kill (Windows) │    │
│  │  • Orphan recovery on restart (PID files on disk)            │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  ApprovalEngine                                              │    │
│  │  • Risk tiers: auto / low / medium / high                    │    │
│  │  • Per-operation rules (see Approval Model below)            │    │
│  │  • "Always allow" persistence via electron-store             │    │
│  │  • Timeout: 5min → auto-deny with notification              │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  AuthManager                                                 │    │
│  │  • OAuth PKCE flow: system browser → Clerk login             │    │
│  │  • Deep link callback: symphony://auth?token=...             │    │
│  │  • Token storage: Electron safeStorage (OS keychain)         │    │
│  │  • Auto-refresh before expiry                                │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  PluginOperationRouter                                       │    │
│  │  • Routes high-level ops to plugin handlers                  │    │
│  │  • Handlers in ~/.claude/plugins/cache/closedloop-ai/ops     │    │
│  │  • Version handshake with server on connect                  │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  electron-store: preferences, allowed directories, approval rules   │
│  electron-log: structured logging to ~/Library/Logs/Symphony/       │
│  electron-updater: auto-update from GitHub Releases                  │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│  Electron Renderer (React + Tailwind)                                │
│                                                                      │
│  ┌────────────────────┐  ┌──────────────────────────────────────┐   │
│  │  System Tray        │  │  Main Window                         │   │
│  │  • Green/amber/red  │  │                                      │   │
│  │    status dot        │  │  ┌─ Onboarding (first run) ───────┐ │   │
│  │  • "Connected to    │  │  │  1. Sign in (OAuth)             │ │   │
│  │    ClosedLoop"       │  │  │  2. Add directories             │ │   │
│  │  • Quick actions:   │  │  │  3. Health check (CLIs)          │ │   │
│  │    - Open window    │  │  │  4. Done                         │ │   │
│  │    - Pause/Resume   │  │  └──────────────────────────────────┘ │   │
│  │    - Quit           │  │                                      │   │
│  └────────────────────┘  │  ┌─ Dashboard ──────────────────────┐ │   │
│                           │  │  Connection: ● Connected          │ │   │
│                           │  │  Active Jobs: 3                   │ │   │
│                           │  │  Pending Approvals: 1             │ │   │
│                           │  │                                    │ │   │
│                           │  │  [Job List]                        │ │   │
│                           │  │   ✓ AI-350: ClosedLoop running    │ │   │
│                           │  │   ◐ AI-351: Awaiting approval     │ │   │
│                           │  │   ✓ AI-352: Review complete       │ │   │
│                           │  └──────────────────────────────────┘ │   │
│                           │                                      │   │
│                           │  ┌─ Approval Queue ────────────────┐ │   │
│                           │  │  "Run code review on AI-351     │ │   │
│                           │  │   using Claude in my-repo"      │ │   │
│                           │  │                                  │ │   │
│                           │  │   Risk: Low (read-only analysis) │ │   │
│                           │  │                                  │ │   │
│                           │  │   [Approve] [Deny] [Always Allow]│ │   │
│                           │  └──────────────────────────────────┘ │   │
│                           │                                      │   │
│                           │  ┌─ Settings ──────────────────────┐ │   │
│                           │  │  Allowed Directories:            │ │   │
│                           │  │   ☑ ~/Source/my-repo             │ │   │
│                           │  │   ☑ ~/Source/other-repo          │ │   │
│                           │  │   [+ Add Directory]              │ │   │
│                           │  │                                  │ │   │
│                           │  │  Auto-Approval Rules:            │ │   │
│                           │  │   ☑ Status checks (auto)        │ │   │
│                           │  │   ☑ Chat messages (low)         │ │   │
│                           │  │   ☐ Git push (medium)           │ │   │
│                           │  │   ☐ Deploy (medium)             │ │   │
│                           │  └──────────────────────────────────┘ │   │
│                           │                                      │   │
│                           │  ┌─ Activity Log ──────────────────┐ │   │
│                           │  │  12:34 symphony_chat AI-350 ✓    │ │   │
│                           │  │  12:33 git_action:status ✓       │ │   │
│                           │  │  12:30 symphony_launch AI-350 ✓  │ │   │
│                           │  │  12:28 health_check ✓            │ │   │
│                           │  └──────────────────────────────────┘ │   │
│                           └──────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
```

### Approval Model

Operations are classified by risk tier. Non-engineers see plain-language descriptions, not raw commands.

| Tier | Behavior | Operations | User Sees |
|------|----------|-----------|-----------|
| **Auto** | Executes without prompt | `symphony_status`, `health_check`, `repos_config` (read), `filesystem` (read), `symphony_sessions` (read) | Activity log entry only |
| **Low** | Approve once per session | `symphony_chat`, `terminal_chat`, `ticket_chat`, `run_viewer_chat`, `codex_review`, `codex_argue`, `symphony_commit_message` | "Send message to AI about ticket AI-350?" |
| **Medium** | Always prompt | `symphony_launch`, `symphony_kill`, `git_action:push`, `git_pr`, `deploy` | "Launch AI coding session for AI-350 in ~/Source/my-repo?" |
| **High** | Always prompt + confirmation | Custom shell commands (future) | Full command displayed with warning |

Users can upgrade any tier to "Always Allow" from the approval dialog. Settings persist in `electron-store`.

### Onboarding Flow (Non-Engineer Optimized)

Modeled after Tailscale's onboarding — minimal steps, immediate value:

1. **Install & Launch**: DMG/MSI/AppImage → double-click → app opens
2. **Sign In**: "Sign in with ClosedLoop" button → system browser opens Clerk login → deep link back → authenticated
3. **Add Directories**: File picker or drag-and-drop to add code directories the app can access (security boundary)
4. **Health Check**: Automatic — shows green/red for each CLI tool (claude, codex, git, gh). Links to install missing tools
5. **Connected**: Tray icon turns green, "Connected to ClosedLoop" — ready to receive jobs from the web UI

Total time: ~2 minutes for an engineer, ~5 minutes for a PM (may need to install CLI tools).

### Data Flow: Web UI → Desktop Client

```
1. PM opens symphony web app → sees ticket AI-350
2. PM clicks "Launch AI Session" on AI-350
3. Web app POST /api/engineer/symphony/launch { ticketId, repoPath, ticket }
4. Server validates, forwards via WebSocket to PM's desktop client
5. Desktop client shows approval: "Launch AI session for AI-350 in my-repo?"
6. PM clicks [Approve]
7. Desktop client executes symphony_launch locally (creates worktree, spawns run-loop.sh)
8. Desktop client streams status back to server via WebSocket
9. Server relays to web app → PM sees "ClosedLoop running" with live status
10. PM can also see status in desktop client's dashboard
```

### Reconnect Protocol

The desktop client must handle disconnects gracefully — a PM closing their laptop and reopening it later is a first-class scenario.

1. **Disconnect detected**: WebSocket `close` event or heartbeat timeout (90s)
2. **Buffer events**: Any in-flight operation results are buffered to disk (not just memory)
3. **Reconnect**: Exponential backoff (1s, 2s, 4s, 8s, 16s, 30s cap) with jitter
4. **Handshake**: Client sends `{ pluginVersion, activeOperations[], activePIDs[] }`
5. **Server reconciles**: Compares client state with expected state, replays missed commands if needed
6. **Resume streams**: For in-flight streaming operations, Electron replays buffered events to server, server relays to browser
7. **Orphan cleanup**: Server notifies client of operations it no longer cares about → client kills orphaned processes

### Security Model

| Layer | Protection |
|-------|-----------|
| **Transport** | WSS only (TLS). Certificate pinning optional. |
| **Authentication** | OAuth PKCE → Clerk JWT → `safeStorage` (OS keychain). Token auto-refresh. |
| **Authorization** | Server validates JWT on every WebSocket message. User can only receive their own operations. |
| **Filesystem sandbox** | Only directories explicitly added by the user in Settings are accessible. Path validation on every operation. |
| **Process sandbox** | Only known CLI tools (claude, codex, git, gh, run-loop.sh, dev servers) can be spawned. No arbitrary command execution. |
| **Approval** | Risk-tiered approval model (see above). Non-auto operations require explicit user consent. |
| **Audit log** | All operations logged locally with timestamps, approval status, and outcomes. |

### Reference Products

| Product | What We Borrow |
|---------|---------------|
| **Tailscale** | Onboarding flow (sign in → add nodes → connected), tray icon status, zero-config networking metaphor |
| **GitHub Desktop** | Operation breadth (commit, push, PR, branch) without exposing git CLI complexity |
| **Dropbox** | Persistent tray icon with sync status (green ✓, blue ◐, red ✗), "just works" background daemon |
| **Docker Desktop** | Dashboard showing running containers (≈ running jobs), log viewer, settings panel |

### Effort Estimates

| Phase | Effort | Scope |
|-------|--------|-------|
| **MVP (macOS only)** | **7-9 weeks** | Electron shell, WSS connection, approval UI, `symphony_launch`/`status`/`kill`/`chat`, `git_action`, `health_check`, onboarding, tray icon |
| **Full parity** | **10-13 weeks** | All 17 operations, settings panel, activity log, auto-update, all approval tiers |
| **Cross-platform (GA)** | **13-17 weeks** | Windows (installer + code signing + tree-kill), Linux (AppImage), CI/CD for all platforms |

### LLM Buildability: ~75%

An LLM can produce ~75% of working code. The remaining ~25% requiring human iteration:

| Area | LLM Can Do | Needs Human |
|------|-----------|-------------|
| React renderer UI | 90% | Edge cases in approval queue state |
| WebSocket connection | 80% | Reconnect protocol, event buffering, race conditions |
| Process spawning | 85% | Process group kill on Windows (`tree-kill`), stdout buffering (8KB highWaterMark) |
| OAuth PKCE flow | 70% | Deep link registration per platform, `safeStorage` API nuances |
| Electron packaging | 60% | Code signing ($99/yr Apple, $300-500/yr Windows), notarization, auto-updater |
| Streaming relay | 75% | Mid-stream disconnect + resume + event replay (3-5 days debugging) |
| Tray icon / notifications | 90% | Platform-specific icon sizing |

### Top Risks

1. **Streaming reconnect correctness** — The hardest engineering problem. A PM's laptop sleeps mid-Claude-stream, wakes up 30 minutes later. The Claude process finished long ago. The desktop client must: detect the disconnect, buffer the final events, reconnect, replay them to the server, and the server must handle this gracefully. Estimated 3-5 days of dedicated debugging.

2. **Code signing cost and friction** — Apple ($99/yr) and Windows ($300-500/yr) code signing certificates are required for untrusted-publisher warnings to go away. The signing process itself is manual and platform-specific. Not an LLM task.

3. **CLI tool installation for non-engineers** — A PM may not have `claude`, `codex`, or `gh` installed. The health check screen needs to provide one-click install links or even bundled installers. This is UX work, not relay work.

4. **Windows process management** — `process.kill(-pid)` doesn't work on Windows. Need `tree-kill` package. WSL may be required for `run-loop.sh` (bash script). This adds ~2-3 weeks to the Windows phase.

---

## Communication Patterns Reference

### Pattern 1: NDJSON Streaming (Most Chat Routes)

```
Client                              API Route                         CLI Process
  |                                    |                                  |
  | POST {message, ...}                |                                  |
  |───────────────────────────────────>|                                  |
  |                                    | spawn("claude", [...args])       |
  |                                    |────────────────────────────────->|
  |                                    |                                  |
  |  {"type":"status","status":"running","pid":123}                       |
  |<───────────────────────────────────|                                  |
  |                                    |  stdout: JSON lines              |
  |  {"type":"text","content":"..."}   |<────────────────────────────────|
  |<───────────────────────────────────|                                  |
  |  {"type":"tool_use","name":"Edit"} |                                  |
  |<───────────────────────────────────|                                  |
  |  {"type":"tool_result","content":} |                                  |
  |<───────────────────────────────────|                                  |
  |  {"type":"done","exitCode":0}      |  process exits                   |
  |<───────────────────────────────────|<────────────────────────────────|
```

- Response header: `Content-Type: text/event-stream`
- Wire format: newline-delimited JSON (not SSE `data:` prefix)
- Client parser: `readChatStream()` in `lib/engineer/chat-utils.ts`
- Kill timer: 30s SIGTERM + 5s SIGKILL after `result` event

### Pattern 2: Polling (Status Routes)

```
Client                              API Route                    Filesystem
  |                                    |                             |
  | GET /status/[ticketId]?repo=...    |                             |
  |───────────────────────────────────>|  read state.json            |
  |                                    |───────────────────────────>|
  |                                    |  check process alive        |
  |                                    |  (kill(pid, 0))             |
  |  { phase, status, taskProgress }   |                             |
  |<───────────────────────────────────|                             |
  |                                    |                             |
  | (repeat every 2-3s)               |                             |
```

### Pattern 3: TanStack Query (Server State Management)

- **13 query domains**: symphony, git, deploy, repos, files, tickets, terminal, healthCheck, etc.
- **Polling queries**: `symphonyStatus` (2-3s), `deployStatus` (2s), `codexReviewStatus` (2s), `deployHealth` (60s)
- **One-shot queries**: `healthCheck`, `codexAvailable`, `githubUser` (all staleTime: Infinity)
- **Cache invalidation**: `queryClient.invalidateQueries()` after mutations

### Pattern 4: NDJSON Streaming via Relay (Proposed)

```
Browser          Remote Server           WebSocket          Electron App        CLI
  |                   |                      |                   |               |
  | POST /chat        |                      |                   |               |
  |──────────────────>|                      |                   |               |
  |                   | relay.spawnStream()  |                   |               |
  |                   |─────────────────────>|                   |               |
  |                   |                      | {cmd,args,stdin}  |               |
  |                   |                      |──────────────────>|               |
  |                   |                      |                   | [User: Allow] |
  |                   |                      |                   | spawn(cmd)    |
  |                   |                      |                   |──────────────>|
  |                   |                      |  stdout line      |               |
  |                   |                      |<──────────────────|  stdout chunk |
  |                   |  stdout line         |                   |<──────────────|
  | {type:"text",...} |<─────────────────────|                   |               |
  |<──────────────────|                      |                   |               |
  |   ...             |                      |                   |               |
  |                   |                      |  {type:"done"}    |               |
  |                   |  {type:"done"}       |<──────────────────|               |
  | {type:"done"}     |<─────────────────────|                   |               |
  |<──────────────────|                      |                   |               |
```

---

## Type System Reference

### Where Types Live

| Location | Scope | Contents |
|----------|-------|----------|
| `apps/app/types/engineer.ts` | UI-wide | `EngineerTicket`, status mappings |
| `apps/app/types/repos.ts` | UI-wide | `ConfiguredRepo`, `RepoSettings`, `DeploymentConfig` |
| `apps/app/types/run-viewer.ts` | Run viewer | `FileTreeNode`, `RunData` |
| `apps/app/components/engineer/chat/types.ts` | Chat | `ChatMessage`, `ContentBlock` |
| `apps/app/lib/engineer/chat-utils.ts` | Stream wire | `StreamEvent`, `StreamEventHandlers`, `SuggestedAction`, `DebateStatus`, `LearningUsed` |
| `apps/app/lib/engineer/stream-events.ts` | Server stream | `StreamState`, `ContentBlock`, processing functions |
| `apps/app/lib/engineer/queries/*.ts` | Query layer | Response types per domain |

### Tool Allow Lists

```ts
ENGINEER_CHAT_TOOLS = "Bash,Grep,Glob,Read,Edit,Write,Task,TodoWrite,WebSearch,WebFetch,mcp__closedloop__*"
READONLY_CODEBASE_TOOLS = "Read,Grep,Glob,WebSearch,WebFetch,mcp__closedloop__*"
WEB_ONLY_TOOLS = "WebSearch,WebFetch,mcp__closedloop__*"
```

### No Shared Types in `packages/api/src/types/`

The engineer feature has zero dedicated types in the shared API types package. It borrows `ArtifactStatus`, `ArtifactType`, `Priority`, `IssueStatus` from existing shared types. All engineer-specific types live exclusively in `apps/app/`.
