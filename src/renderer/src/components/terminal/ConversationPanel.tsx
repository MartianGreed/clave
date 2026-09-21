import {
  attachmentIssue,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_IMAGE_BYTES,
  type AttachmentSource,
  type ConversationAttachment
} from '../../../../shared/conversation-attachments'
import { ConversationAttachments } from './ConversationAttachments'
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  ArrowDownIcon,
  ArrowPathIcon,
  ArrowUpIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
  ShieldCheckIcon,
  PaperClipIcon,
  XMarkIcon,
  StopIcon
} from '@heroicons/react/24/outline'
import type {
  AgentRequest,
  AgentResponse,
  ConversationProvider,
  ConversationSnapshot,
  ConversationStatus
} from '../../../../shared/agent-session'
import { subscribeConversation } from '../../lib/conversation-subscription'
import {
  conversationComposer,
  isNearLatest,
  MAX_PROMPT_BYTES,
  shouldSendOnEnter
} from '../../lib/conversation-composer'
import { MarkdownRenderer } from '../files/MarkdownRenderer'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { TerminalHeader } from './TerminalHeader'
import { useSessionStore } from '../../store/session-store'
import { PluginEntryView } from './PluginEntryView'
import { ConversationToolGroup } from './ConversationToolGroup'
import { groupConversationEntries } from '../../lib/conversation-tools'
import { isHistoryBoundary } from '../../lib/conversation-history'

const PROVIDER_NAMES: Record<ConversationProvider, string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  pi: 'Pi'
}
const STATUS_LABELS: Record<ConversationStatus, string> = {
  starting: 'Connecting',
  idle: 'Ready',
  running: 'Working',
  waiting: 'Needs your input',
  stopped: 'Stopped',
  error: 'Needs attention',
  closed: 'Closed'
}

function SessionDetails({ snapshot }: { snapshot: ConversationSnapshot }): React.JSX.Element {
  const { session } = snapshot
  const [open, setOpen] = useState(false)
  useEffect(
    () =>
      useSessionStore.subscribe((state, previous) => {
        if (
          state.focusedSessionId !== previous.focusedSessionId &&
          state.focusedSessionId !== session.id
        ) {
          setOpen(false)
        }
      }),
    [session.id]
  )
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className="panel-icon-btn" aria-label="Session details" title="Session details">
          <InformationCircleIcon className="w-4 h-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="conversation-details" aria-label="Session details">
        <div data-testid="conversation-capabilities">
          <h3>{PROVIDER_NAMES[session.provider] ?? session.provider}</h3>
          <p>Provider fixed for this session. Switching views does not interrupt the agent.</p>
          <dl>
            <dt>Folder</dt>
            <dd>{session.cwd}</dd>
            {session.model && (
              <>
                <dt>Model</dt>
                <dd>{session.model}</dd>
              </>
            )}
            <dt>Permissions</dt>
            <dd>
              {session.capabilities.permissions
                ? 'Permission review available'
                : 'Permission review not supported'}
            </dd>
            <dt>Questions</dt>
            <dd>
              {session.capabilities.questions ? 'Questions supported' : 'Questions not supported'}
            </dd>
            <dt>History</dt>
            <dd>{session.capabilities.resume ? 'Resume supported' : 'Resume not supported'}</dd>
          </dl>
          {session.capabilities.notice && <p>{session.capabilities.notice}</p>}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function RequestControl({
  request,
  respond,
  busy
}: {
  request: AgentRequest
  respond: (response: AgentResponse) => void
  busy: boolean
}): React.JSX.Element {
  const [answer, setAnswer] = useState('')
  return (
    <section className="conversation-request" aria-label={request.kind}>
      <div className="conversation-request-heading">
        <ShieldCheckIcon className="w-4 h-4" />
        <span>
          {request.kind === 'permission' ? 'Your approval is needed' : 'A question for you'}
        </span>
      </div>
      <p className="conversation-request-title">{request.title}</p>
      {request.description && (
        <pre className="conversation-request-description">{request.description}</pre>
      )}
      {request.kind === 'permission' ? (
        <div className="conversation-actions">
          <button
            className="btn-secondary"
            disabled={busy}
            onClick={() => respond({ requestId: request.id, decision: 'deny' })}
          >
            Deny
          </button>
          <button
            className="btn-primary"
            disabled={busy}
            onClick={() => respond({ requestId: request.id, decision: 'allow' })}
          >
            Allow
          </button>
        </div>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (!busy && answer.trim()) respond({ requestId: request.id, answer })
          }}
        >
          <div className="conversation-actions">
            {request.choices?.map((choice) => (
              <button
                key={choice}
                type="button"
                className="btn-secondary"
                disabled={busy}
                onClick={() => respond({ requestId: request.id, answer: choice })}
              >
                {choice}
              </button>
            ))}
          </div>
          <div className="conversation-answer">
            <input
              className="input-field"
              aria-label="Answer"
              placeholder="Write your answer"
              disabled={busy}
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
            />
            <button className="btn-primary" disabled={busy || !answer.trim()}>
              Answer
            </button>
          </div>
        </form>
      )}
    </section>
  )
}

/** Local view state resets between sessions; drafts deliberately outlive the view. */
export function ConversationPanel({ sessionId }: { sessionId: string }): React.JSX.Element {
  return <ConversationView key={sessionId} sessionId={sessionId} />
}

function ConversationView({ sessionId }: { sessionId: string }): React.JSX.Element {
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)
  const [snapshot, setSnapshot] = useState<ConversationSnapshot>()
  const [connectionError, setConnectionError] = useState<string>()
  const [actionError, setActionError] = useState<string>()
  const [actionBusy, setActionBusy] = useState(false)
  const [requestBusy, setRequestBusy] = useState(false)
  const [retry, setRetry] = useState(0)
  const [atLatest, setAtLatest] = useState(true)
  const composer = useSyncExternalStore(conversationComposer.subscribe, () =>
    conversationComposer.read(sessionId)
  )
  const focused = useSessionStore((state) => state.focusedSessionId === sessionId)
  const viewport = useRef<HTMLDivElement>(null)
  const transcript = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const historyCaret = useRef<'older' | 'newer' | undefined>(undefined)
  const following = useRef(true)
  const session = snapshot?.session
  const provider = session ? (PROVIDER_NAMES[session.provider] ?? session.provider) : 'agent'
  const running = !!session && ['starting', 'running', 'waiting'].includes(session.status)
  const imagesSupported =
    session?.capabilities.images ??
    (!!session &&
      ['claude', 'codex', 'pi', 'opencode'].includes(session.provider) &&
      (!session.pluginBindings ||
        session.pluginBindings.provider.pluginId === `builtin.${session.provider}`))
  const attachmentBlocked =
    composer.preparations.length > 0 ||
    composer.attachments.some((file) => attachmentIssue(file, imagesSupported))
  const hasDraft = !!composer.text.trim() || composer.attachments.length > 0
  const canSend =
    !!session &&
    session.status !== 'closed' &&
    !running &&
    !composer.sending &&
    !actionBusy &&
    !attachmentBlocked
  const error = actionError || connectionError || session?.error

  useEffect(
    () =>
      subscribeConversation(
        window.electronAPI.conversations,
        sessionId,
        (next) => {
          setSnapshot(next)
          setConnectionError(undefined)
          if (next.session.status === 'closed') conversationComposer.clear(sessionId)
          useSessionStore.setState((state) => ({
            sessions: state.sessions.map((item) =>
              item.id === sessionId
                ? {
                    ...item,
                    agentState:
                      next.session.status === 'running'
                        ? 'working'
                        : next.session.status === 'waiting'
                          ? 'blocked'
                          : 'idle',
                    activityStatus:
                      next.session.status === 'running'
                        ? 'active'
                        : next.session.status === 'closed'
                          ? 'ended'
                          : 'idle',
                    claudeSessionId:
                      next.session.provider === 'claude'
                        ? (next.session.providerSessionId ?? null)
                        : item.claudeSessionId,
                    piSessionId:
                      next.session.provider === 'pi'
                        ? next.session.providerSessionId
                        : item.piSessionId,
                    alive: next.session.status !== 'closed'
                  }
                : item
            )
          }))
        },
        (failure) => setConnectionError(failure.message)
      ),
    [sessionId, retry]
  )

  useEffect(() => {
    const preventFileNavigation = (event: DragEvent): void => {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault()
      if (event.type === 'drop' || event.type === 'dragend') {
        dragDepth.current = 0
        setDragging(false)
      }
    }
    window.addEventListener('dragover', preventFileNavigation)
    window.addEventListener('drop', preventFileNavigation)
    window.addEventListener('dragend', preventFileNavigation)
    return () => {
      window.removeEventListener('dragover', preventFileNavigation)
      window.removeEventListener('drop', preventFileNavigation)
      window.removeEventListener('dragend', preventFileNavigation)
    }
  }, [])
  const updateFiles = (files: ConversationAttachment[]): void => {
    conversationComposer.edit(sessionId, conversationComposer.read(sessionId).text, files)
  }
  const addFiles = async (sources: (File | string)[]): Promise<void> => {
    if (session?.status === 'closed') return
    setActionError(undefined)
    // Reserve the whole batch before awaiting IO. Closing the session or removing
    // a pending chip can then cancel every remaining preparation in this batch.
    const queued: { source: File | string; key: string }[] = []
    for (const source of sources) {
      const name = typeof source === 'string' ? source.split(/[\\/]/).pop()! : source.name
      const key = conversationComposer.prepare(sessionId, name || 'Pasted image')
      if (!key) {
        setActionError('Attach up to 10 files per message.')
        break
      }
      queued.push({ source, key })
    }
    for (const { source, key } of queued) {
      if (!conversationComposer.read(sessionId).preparations.some((item) => item.id === key))
        continue
      try {
        let value: AttachmentSource
        if (typeof source === 'string') value = { path: source }
        else {
          const path = window.electronAPI.getPathForFile(source)
          if (path) value = { path }
          else {
            if (source.size > MAX_IMAGE_BYTES)
              throw new Error('Pasted images must be 5 MiB or smaller.')
            value = {
              name: source.name || 'Pasted image.png',
              bytes: new Uint8Array(await source.arrayBuffer())
            }
          }
        }
        const file = await window.electronAPI.conversationFiles.prepare(sessionId, value)
        conversationComposer.prepared(sessionId, key, file)
      } catch (failure) {
        conversationComposer.prepared(sessionId, key, undefined, String(failure))
      }
    }
    input.current?.focus({ preventScroll: true })
  }
  const fileDrag = (transfer: DataTransfer): boolean =>
    transfer.types.includes('Files') || transfer.types.includes('text/uri-list')
  const scrollToLatest = (): void => {
    following.current = true
    setAtLatest(true)
    if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight
  }
  useLayoutEffect(() => {
    if (following.current && viewport.current)
      viewport.current.scrollTop = viewport.current.scrollHeight
  }, [snapshot?.sequence])
  useEffect(() => {
    if (!transcript.current) return
    const observer = new ResizeObserver(() => {
      if (following.current && viewport.current)
        viewport.current.scrollTop = viewport.current.scrollHeight
    })
    observer.observe(transcript.current)
    return () => observer.disconnect()
  }, [])
  useLayoutEffect(() => {
    if (!input.current) return
    input.current.style.height = 'auto'
    input.current.style.height = `${input.current.scrollHeight}px`
    if (historyCaret.current) {
      const position = historyCaret.current === 'older' ? input.current.value.length : 0
      input.current.setSelectionRange(position, position)
      historyCaret.current = undefined
    }
  }, [composer.text, composer.revision])
  useEffect(() => {
    if (focused) input.current?.focus({ preventScroll: true })
  }, [focused])

  const run = async (action: () => Promise<void>): Promise<void> => {
    if (actionBusy) return
    setActionBusy(true)
    setActionError(undefined)
    try {
      await action()
    } catch (failure) {
      setActionError(String(failure))
    } finally {
      setActionBusy(false)
    }
  }
  const send = (): void => {
    if (!canSend) return
    if (new TextEncoder().encode(composer.text).length > MAX_PROMPT_BYTES) {
      setActionError(
        'This message is too large. Keep it under 128 KiB or refer to a file in your project.'
      )
      return
    }
    if (
      composer.attachments
        .filter((file) => file.delivery === 'image')
        .reduce((sum, file) => sum + file.size, 0) > MAX_TOTAL_IMAGE_BYTES
    ) {
      setActionError('Images in one message must total 20 MiB or less.')
      return
    }
    const command = conversationComposer.begin(sessionId)
    if (!command) return
    setActionError(undefined)
    scrollToLatest()
    void window.electronAPI.conversations
      .send(sessionId, command.text, command.commandId, command.attachments)
      .then(() => {
        conversationComposer.accept(sessionId, command.commandId)
      })
      .catch((failure) => {
        conversationComposer.fail(sessionId, command.commandId)
        setActionError(String(failure))
      })
  }
  const prefill = (text: string, files?: ConversationAttachment[]): void => {
    conversationComposer.edit(sessionId, text, files)
    input.current?.focus()
  }

  return (
    <div
      className="conversation-panel"
      data-testid="conversation-panel"
      data-conversation-id={sessionId}
      onDragEnter={(event) => {
        if (!fileDrag(event.dataTransfer) || session?.status === 'closed') return
        event.preventDefault()
        event.stopPropagation()
        dragDepth.current++
        setDragging(true)
      }}
      onDragOver={(event) => {
        if (!fileDrag(event.dataTransfer)) return
        event.preventDefault()
        event.stopPropagation()
        event.dataTransfer.dropEffect = session?.status === 'closed' ? 'none' : 'copy'
      }}
      onDragLeave={(event) => {
        if (!fileDrag(event.dataTransfer)) return
        event.stopPropagation()
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (!dragDepth.current) setDragging(false)
      }}
      onDrop={(event) => {
        if (!fileDrag(event.dataTransfer)) return
        event.preventDefault()
        event.stopPropagation()
        dragDepth.current = 0
        setDragging(false)
        const files = Array.from(event.dataTransfer.files)
        const paths = event.dataTransfer
          .getData('text/uri-list')
          .split(/\r?\n/)
          .flatMap((line) => {
            try {
              const url = new URL(line)
              return url.protocol === 'file:' && (!url.hostname || url.hostname === 'localhost')
                ? [decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:\/)/, '$1')]
                : []
            } catch {
              return []
            }
          })
        void addFiles(files.length ? files : paths)
      }}
      onMouseDown={() => useSessionStore.getState().setFocusedSession(sessionId)}
    >
      {dragging && (
        <div className="conversation-drop-overlay" role="status">
          <PaperClipIcon className="w-6 h-6" />
          <strong>Add files to this conversation</strong>
          <span>{session?.title || provider}</span>
          <small>Files will be ready to review before you send.</small>
        </div>
      )}
      <TerminalHeader sessionId={sessionId} />
      <div className="conversation-toolbar">
        <div className="conversation-identity">
          <span>{session ? provider : 'Conversation'}</span>
          {session?.model && (
            <span className="conversation-model" title={session.model}>
              {session.model}
            </span>
          )}
        </div>
        <span
          className="conversation-status"
          data-state={error ? 'error' : session?.status}
          role="status"
        >
          {connectionError
            ? 'Connection lost'
            : session
              ? STATUS_LABELS[session.status]
              : 'Connecting'}
        </span>
        {snapshot && <SessionDetails snapshot={snapshot} />}
      </div>
      {session?.provider === 'pi' && !session.capabilities.permissions && (
        <div className="conversation-notice" role="note">
          <InformationCircleIcon className="w-4 h-4" />
          <p>Permission review not supported by Pi. Tools can run without approval prompts.</p>
        </div>
      )}
      <div className="conversation-reading">
        <div
          ref={viewport}
          className="conversation-scroll"
          data-testid="conversation-scroll"
          aria-label="Conversation messages"
          tabIndex={0}
          onScroll={(event) => {
            const near = isNearLatest(event.currentTarget)
            following.current = near
            setAtLatest(near)
          }}
        >
          <div ref={transcript} className="conversation-transcript">
            {!snapshot ? (
              <div className="conversation-empty">
                <p>Connecting to your conversation…</p>
              </div>
            ) : snapshot.entries.length === 0 ? (
              <div className="conversation-empty">
                <h2>What would you like to work on?</h2>
                {session?.legacyImport?.complete && (
                  <p>
                    Provider context may resume. Earlier native transcript is not re-imported here.
                  </p>
                )}
                <p>Ask {provider} to explore this project, plan a change, or help with a bug.</p>
                <div className="conversation-actions">
                  <button
                    className="btn-secondary"
                    onClick={() =>
                      prefill(
                        'Explain how this project is organized and where its main entry points are.'
                      )
                    }
                  >
                    Explore this project
                  </button>
                  <button
                    className="btn-secondary"
                    onClick={() =>
                      prefill(
                        'Help me plan a change to this project. Start by asking what I want to achieve.'
                      )
                    }
                  >
                    Plan a change
                  </button>
                </div>
                <span className="conversation-folder" title={session?.cwd}>
                  {session?.cwd}
                </span>
              </div>
            ) : (
              groupConversationEntries(snapshot.entries).map((entry) => {
                switch (entry.kind) {
                  case 'message':
                    return (
                      <article
                        key={entry.id}
                        aria-label={`${entry.role} message`}
                        className="conversation-message"
                        data-role={entry.role}
                      >
                        <ConversationAttachments files={entry.attachments ?? []} />
                        {entry.role === 'user' ? (
                          <p className="conversation-user-text">{entry.text}</p>
                        ) : (
                          <MarkdownRenderer content={entry.text} />
                        )}
                      </article>
                    )
                  case 'artifact':
                    return <PluginEntryView key={entry.id} sessionId={sessionId} entry={entry} />
                  case 'tool-group':
                    return (
                      <ConversationToolGroup
                        key={entry.id}
                        sessionId={sessionId}
                        tools={entry.tools}
                        onInspect={() => {
                          following.current = false
                          setAtLatest(false)
                        }}
                      />
                    )
                }
              })
            )}
            {session?.status === 'running' && (
              <div className="conversation-progress" role="status">
                <ArrowPathIcon className="conversation-working w-4 h-4" />
                {provider} is working…
              </div>
            )}
          </div>
        </div>
        {!atLatest && (
          <button className="btn-secondary conversation-jump" onClick={scrollToLatest}>
            <ArrowDownIcon className="w-4 h-4" />
            Jump to latest
          </button>
        )}
      </div>
      {!!snapshot?.requests.length && (
        <div className="conversation-requests">
          {snapshot.requests.map((request) => (
            <RequestControl
              key={request.id}
              request={request}
              busy={requestBusy}
              respond={(response) => {
                setRequestBusy(true)
                setActionError(undefined)
                void window.electronAPI.conversations
                  .respond(sessionId, response)
                  .catch((failure) => setActionError(String(failure)))
                  .finally(() => setRequestBusy(false))
              }}
            />
          ))}
        </div>
      )}
      {error && (
        <div role="alert" className="conversation-error">
          <div className="conversation-request-heading">
            <ExclamationTriangleIcon className="w-4 h-4" />
            Something needs attention
          </div>
          <p>{error}</p>
          <div className="conversation-actions">
            <button
              className="btn-secondary"
              onClick={() => {
                setActionError(undefined)
                setConnectionError(undefined)
                setRetry((value) => value + 1)
              }}
            >
              Reconnect
            </button>
            {hasDraft && (
              <button className="btn-primary" disabled={!canSend} onClick={send}>
                Retry send
              </button>
            )}
            {!hasDraft && session?.status === 'error' && (
              <button
                className="btn-secondary"
                disabled={!canSend}
                onClick={() => {
                  const previous = snapshot?.entries.findLast(
                    (entry) => entry.kind === 'message' && entry.role === 'user'
                  )
                  if (previous?.kind === 'message')
                    prefill(previous.text, previous.attachments ?? [])
                }}
              >
                Edit last message
              </button>
            )}
          </div>
        </div>
      )}
      <form
        className="conversation-compose"
        onSubmit={(event) => {
          event.preventDefault()
          send()
        }}
      >
        <div className="conversation-compose-box">
          <div className="conversation-compose-files">
            <ConversationAttachments
              files={composer.attachments}
              imagesSupported={imagesSupported}
              onChange={updateFiles}
            />
            {!!composer.preparations.length && (
              <ul className="conversation-attachments" aria-label="Preparing files">
                {composer.preparations.map((item) => (
                  <li key={item.id} className="conversation-attachment" data-error={!!item.error}>
                    <span role={item.error ? 'alert' : 'status'}>
                      {item.name} · {item.error || 'Preparing…'}
                    </span>
                    <button
                      type="button"
                      className="panel-icon-btn"
                      aria-label={`Remove ${item.name}`}
                      onClick={() => conversationComposer.removePreparation(sessionId, item.id)}
                    >
                      <XMarkIcon className="w-4 h-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <textarea
            ref={input}
            className="textarea-field conversation-input"
            rows={2}
            aria-label="Message"
            aria-describedby={`composer-hint-${sessionId}`}
            placeholder={running ? 'Draft your next message…' : `Message ${provider}…`}
            disabled={session?.status === 'closed'}
            maxLength={MAX_PROMPT_BYTES}
            value={composer.text}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.files)
              if (!files.length) return
              event.preventDefault()
              void addFiles(files)
            }}
            onChange={(event) => conversationComposer.edit(sessionId, event.target.value)}
            onKeyDown={(event) => {
              if (
                (event.key === 'ArrowUp' || event.key === 'ArrowDown') &&
                !event.shiftKey &&
                !event.altKey &&
                !event.ctrlKey &&
                !event.metaKey &&
                !event.nativeEvent.isComposing &&
                event.nativeEvent.keyCode !== 229
              ) {
                const direction = event.key === 'ArrowUp' ? 'older' : 'newer'
                if (
                  isHistoryBoundary(event.currentTarget, direction) &&
                  conversationComposer.recall(
                    sessionId,
                    direction,
                    snapshot?.entries.flatMap((entry) =>
                      entry.kind === 'message' && entry.role === 'user'
                        ? [{ text: entry.text, attachments: entry.attachments }]
                        : []
                    ) ?? []
                  )
                ) {
                  event.preventDefault()
                  event.stopPropagation()
                  historyCaret.current = direction
                  return
                }
              }
              if (
                shouldSendOnEnter({
                  key: event.key,
                  shiftKey: event.shiftKey,
                  altKey: event.altKey,
                  isComposing: event.nativeEvent.isComposing
                })
              ) {
                event.preventDefault()
                event.stopPropagation()
                send()
              }
            }}
          />
          <div className="conversation-compose-footer">
            <button
              type="button"
              className="panel-icon-btn"
              aria-label="Add files"
              title="Add files"
              disabled={session?.status === 'closed'}
              onClick={() => {
                void window.electronAPI.conversationFiles
                  .pick()
                  .then((paths) => addFiles(paths))
                  .catch((failure) => setActionError(String(failure)))
              }}
            >
              <PaperClipIcon className="w-4 h-4" />
            </button>
            <span id={`composer-hint-${sessionId}`}>
              {composer.localOnly
                ? 'Draft is only kept in this window'
                : composer.sending
                  ? 'Sending…'
                  : actionBusy
                    ? 'Stopping…'
                    : running
                      ? 'You can draft while the agent works'
                      : !composer.text &&
                          !composer.attachments.length &&
                          !composer.preparations.length &&
                          snapshot?.entries.some(
                            (entry) => entry.kind === 'message' && entry.role === 'user'
                          )
                        ? 'Enter to send · ↑ for message history'
                        : 'Enter to send · Shift+Enter for a new line'}
            </span>
            {running ? (
              <button
                className="panel-icon-btn"
                type="button"
                aria-label="Stop"
                title="Stop this response"
                disabled={actionBusy}
                onClick={() => {
                  void run(() => window.electronAPI.conversations.interrupt(sessionId))
                }}
              >
                <StopIcon className="w-4 h-4" />
              </button>
            ) : (
              <button
                className="panel-icon-btn conversation-send"
                aria-label="Send"
                title="Send message"
                disabled={!canSend || !hasDraft}
              >
                <ArrowUpIcon className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      </form>
    </div>
  )
}
