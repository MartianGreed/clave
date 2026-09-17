# Conversation sessions

New Claude, Codex, Pi, and OpenCode sessions use a Clave-owned conversation
view. Each session has a fixed provider. Terminal tabs, Antigravity,
`claude agents`, and previously recorded terminal sessions keep their PTY
implementation.

## Ownership

The renderer is a subscriber, not the owner of the provider process.

- Electron main resolves launch profiles, working directories, account
  credentials, and window ownership.
- A detached local service owns provider processes and durable session state.
  Quitting Electron disconnects its client without terminating these processes.
- An adapter translates one provider's protocol into Clave messages, tool
  activity, requests, and lifecycle events.
- The renderer uses the same commands and event projection for every provider.

The public IPC accepts conversation operations, not executables or environment
variables. Main resolves those from existing trusted settings. Environment
variables and account tokens cross the authenticated local connection but are
not saved in conversation records or returned to the renderer.

Before creating a headless session, Clave requires workspace trust using the
existing trusted-root registry. An untrusted folder gets an explicit confirmation:
provider startup hooks and plugins can run before tool-approval requests exist.
Cancelling creates no provider session. Explicitly trusted workspace roots do not
prompt again.

The service uses a private authenticated Unix socket on macOS/Linux and a
named pipe on Windows. Service data lives under
`<userData>/conversation-service/`. Provider session files live under
`<userData>/conversations/providers/` where supported. Provider-owned history
may also remain in the provider's native storage.

A kernel-held loopback port elects the service owner, so stale PID files cannot
block recovery or cause two services to take the same socket. That port accepts
no commands. A collision with another local listener fails explicitly; it never
replaces that listener.

## Lifecycle

Creating a session saves its identity and options. The provider process starts
on the first message. Closing the view does not close the session. Explicitly
closing the tab disposes its provider process and closes the session.

Reopening Clave reattaches to the service and reads a snapshot. It does not send
the previous prompt again. If the service itself dies or the machine reboots,
records reopen as stopped, with pending permission requests cancelled. A later
explicit send starts the provider with its saved conversation ID when supported.
This resumes provider context; it does not resurrect a process.

Each accepted send has a durable command ID. Retrying the same command ID does
not execute it twice. A disconnect after submission can leave its outcome
unknown. Neither transport reconnection nor daemon recovery automatically
replays it.

The event sequence is per Clave session. A view subscribes before reading its
snapshot, buffers concurrent events, and discards events already represented by
that snapshot. Sequence gaps trigger a fresh snapshot.

Moving a tab between windows changes its home metadata and transfers the view.
It does not restart the agent. Closing a non-last window hands its conversations
and group layout to the primary window.

Text deltas batch for up to 40 ms. Non-text events, snapshots, and accepted
commands flush immediately. An abrupt service kill can lose the last unflushed
text batch, but does not cause accepted commands to replay.

The current view retains the whole Clave transcript up to a 4 MiB UTF-8 snapshot
limit. At capacity, the session stops with an explicit error and preserves its
existing history; it never silently deletes earlier messages. Continuing requires
a new session. History pagination is not implemented. Individual prompts have a
128 KiB service limit, and at most 1,000 sessions may remain open. Closed records
are archived and do not count toward that active-session limit.

## Provider protocols

| Provider | Interface                                                                                     |
| -------- | --------------------------------------------------------------------------------------------- |
| Claude   | Installed Claude CLI with stream-JSON input/output and control messages. No Claude Agent SDK. |
| Codex    | Installed `codex app-server` over stdio.                                                      |
| OpenCode | A Clave-owned `opencode serve` instance on authenticated loopback HTTP with SSE.              |
| Pi       | Installed `pi --mode rpc` over JSONL stdio.                                                   |

See `src/main/conversations/adapters/README.md` for tested versions, supported
requests, and protocol-specific limitations. An adapter must reject unsupported
actionable requests, not silently approve them or leave the user waiting.

The view is shared; provider capabilities are not necessarily identical.
In particular, Pi's RPC mode does not provide the same tool permission-review
contract as Claude, Codex, and OpenCode. Its limitation is displayed in the view.
Do not describe that as Clave granting permission for each tool call.

The existing Claude account selection supplies the CLI's environment. No SDK
dependency or new Claude login flow is introduced.

## Compatibility boundaries

- Existing tmux sessions are not converted into protocol sessions. Restore
  continues to attach to their terminal processes.
- OpenCode is a direct launcher option. The current `.clave` format has no
  OpenCode agent field. Pinning or exporting an OpenCode session is explicitly
  rejected instead of silently writing a plain terminal.
- Changing providers creates a separate session. Clave does not claim that
  another provider can inherit the original agent's internal context.
- The in-app MCP server still belongs to Electron. Agents can keep working
  while Clave is closed, but Clave-specific MCP tools need the app running.
  Per-session MCP credentials survive restarts without rotation.
- Windows named-pipe and packaged-app behavior require platform verification;
  macOS development verification is not evidence for those environments.

## Verification contract

The change is checked at three levels:

1. Pure tests cover projection ordering, duplicate commands, credential
   separation, permission validation, recovery, and provider protocol fixtures.
2. Real Electron tests with fake providers cover the complete IPC/service/view
   path without model calls. Quitting and reopening the app must retain the
   same provider process and transcript.
3. Installed CLI smoke tests use isolated configuration and perform version and
   initialization handshakes only. They do not prove billable model execution.

Provider upgrades need adapter contract tests and a handshake smoke test against
the new version. Fixtures reduce maintenance scope; they do not make upstream
protocol changes automatically compatible.
