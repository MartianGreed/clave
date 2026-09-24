# ADR 0002: account pools and limit-driven switching

Status: proposed, 2026-09-24

## Context

A user works on several subscriptions at once: a personal plan, a company plan, and seats on teams that pay for their own. Today a Claude session can run on one of several accounts, chosen by hand at launch, and a Codex session always runs on whatever `~/.codex/auth.json` holds. When a subscription nears its cap the only way out is to pick another agent profile by hand and start over.

The current Claude account model (`src/main/claude-accounts.ts`) has three shapes: a pasted `claude setup-token` token held encrypted by `safeStorage`, a `CLAUDE_CONFIG_DIR` of its own, and the machine login. Codex has no account model at all; the usage read opens a short-lived `codex app-server` and asks it which account it is signed into.

## Decision

Clave keeps a pool of accounts per provider and can move work from one subscription to another when the first one is about to run out. Claude and Codex are supported first.

### Two managers, one policy

Each provider keeps its own account manager. The Claude manager already exists; a Codex manager is added beside it. A single switching policy sits above both and speaks in terms of an account's headroom, never in provider terms. The Claude manager's trust boundary and its tests are not touched by the Codex work.

### Claude accounts: one home, token credentials only

Every Claude account shares the machine's `~/.claude`. An account is a label plus a long-lived `claude setup-token` token, injected into the session as `CLAUDE_CODE_OAUTH_TOKEN`. History, plugins and settings stay shared, so a session can be resumed on any account. The config-dir shape is retired: existing config-dir accounts are migrated to token accounts on first launch after the change, and the user is asked to sign in again for each. The machine login remains the built-in Default account.

The token is stored as today, encrypted by the OS through `safeStorage`, and never leaves the main process. Clave records the capture date and assumes a one-year lifetime. The Accounts page shows the remaining lifetime. The first 401 on a read or a spawn marks the account dead and takes it out of the pool.

### Codex accounts: one home per account, everything symlinked but the credential

The Default Codex account is `~/.codex` as the user left it. Every other Codex account gets a directory of its own under Clave's user data, used as `CODEX_HOME` for the sessions that run on it. That directory holds a real `auth.json` and a symlink for every other top-level entry of `~/.codex`, so config, sessions, memories, skills and hooks stay shared and `codex resume` works across accounts.

The credential file is the source of truth. Codex refreshes it in place, so Clave keeps no encrypted copy; the file is protected by directory permissions, as Codex itself protects the default one. Codex rewrites some files by writing a temporary file and renaming it, which turns a symlink into a detached copy. Clave re-syncs the per-account home at every spawn: a missing link is added, a detached file is left as it is until the next spawn re-links it, and the edit made through the detached copy is lost. This is accepted.

### Logging in

The new Settings → Accounts page carries one "Log in" button per provider. Clave runs the provider's own login command in a hidden PTY owned by the main process, opens the browser link the command prints, captures the credential, and never renders it:

- Claude runs `claude setup-token` and captures the printed token by its `sk-ant-` shape. Pasting a token stays available as an alternative.
- Codex runs `codex login` with `CODEX_HOME` set to the new account's directory, so the credential lands in that account's `auth.json` and nowhere else.
- A Codex API-key account takes the key from an input and runs `codex login --with-api-key` against its own home. Such an account has no quota to read, so it never counts as "about to hit"; it is a fallback that the pool only reaches when every subscription account is exhausted.

The user can add as many accounts as they hold.

### What "about to hit the limit" means

An account is exhausted when its tightest usage window, as `tightestWindow()` picks it today, has about five percent or less left. The threshold is the same for both providers. Claude reads the unified rate-limit headers or the usage endpoint as today; Codex reads `account/rateLimits/read`.

### When a switch happens

A running session is never interrupted by the poll. The five-minute usage poll does two things only: it rotates the account that the next spawn on that provider will use, and it raises a badge on sessions whose account is exhausted.

A session moves to another account only when its own CLI reports the limit, or when the user asks. The move is a restart of the CLI on the new account with the provider's resume (`claude --resume` or `codex resume`), so the transcript comes along and no handoff summary is needed.

### Order and configuration

The pool rotates round robin: the accounts of the provider in the order the user set on the Accounts page, starting after the one just left, skipping any that is exhausted, expired, dead, or pinned out. When every account is exhausted the next spawn takes the one that resets soonest. The list is reorderable.

Two knobs are configurable at the workspace level with a per-session override:

- **Mode**: `propose` (default) shows the switch and waits for the user; `automatic` performs it.
- **Pin**: off by default; a pinned session never leaves its account.

### Records, `.clave` files and agents

The session record keeps the account id and label so that a restore after a crash reopens the session on the account it last ran on. A switch rewrites the record.

The `.clave` schema gains an account field that names an account by label, or `any` for the pool. Labels are per machine and ids are not, and `.clave` files are committed and shared. An unknown label falls back to the Default account with a visible note. The field does not drive an agent, so it is not elevated; it still moves through all six mirrors of the schema and both round-trip normalisations, as the schema sync rule requires.

`clave_open_session` takes the same label or `any`. An agent may ask to move its own session to another account through the MCP tools; the request goes through the same mode setting as a user-initiated switch.

### First cut

The first delivery is the Accounts page with both login flows, the migration of config-dir accounts, the Codex per-account home, the exhaustion badge, the manual switch with resume, and the poll-driven rotation for new spawns. The `propose` mode and the `automatic` mode, pins, and the `.clave` field come second, once the manual path is proven.

## Consequences

Switching subscriptions no longer means choosing another agent profile: an agent profile describes how a CLI is launched, an account describes who pays, and they compose. The usage poll already reads every Claude account; it now reads every Codex account through its own home, one short-lived app-server per account. A Claude token account costs about twenty tokens per read.

Two subscriptions in flight at once is the normal case: one session may be on the company seat while another is on a personal plan. Each session's account is visible in its header and in `clave_list`.

Out of scope: Antigravity and Pi accounts, Claude API-key accounts, automatic switching triggered by scanning a PTY's output, and any handoff summary between accounts.
