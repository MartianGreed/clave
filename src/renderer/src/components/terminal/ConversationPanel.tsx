import { useEffect, useRef, useState } from 'react'
import { ArrowUpIcon, StopIcon } from '@heroicons/react/24/outline'
import type {
  AgentRequest,
  AgentResponse,
  ConversationSnapshot
} from '../../../../shared/agent-session'
import { subscribeConversation } from '../../lib/conversation-subscription'
import { MarkdownRenderer } from '../files/MarkdownRenderer'
import { TerminalHeader } from './TerminalHeader'
import { useSessionStore } from '../../store/session-store'

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
    <section className="settings-card p-3" aria-label={request.kind}>
      <p>{request.title}</p>
      {request.description && <p className="text-text-secondary">{request.description}</p>}
      {request.kind === 'permission' ? (
        <div className="flex gap-2">
          <button
            className="btn-primary"
            disabled={busy}
            onClick={() => respond({ requestId: request.id, decision: 'allow' })}
          >
            Allow
          </button>
          <button
            className="btn-secondary"
            disabled={busy}
            onClick={() => respond({ requestId: request.id, decision: 'deny' })}
          >
            Deny
          </button>
        </div>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (answer.trim()) respond({ requestId: request.id, answer })
          }}
        >
          <div className="flex flex-wrap gap-2">
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
          <input
            className="input-field w-full"
            aria-label="Answer"
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
          />
          <button className="btn-primary" disabled={busy || !answer.trim()}>
            Answer
          </button>
        </form>
      )}
    </section>
  )
}

export function ConversationPanel({ sessionId }: { sessionId: string }): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<ConversationSnapshot>()
  const [error, setError] = useState<string>()
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [requestBusy, setRequestBusy] = useState(false)
  const [retry, setRetry] = useState(0)
  const lastSend = useRef<{ text: string; commandId: string } | null>(null)
  const bottom = useRef<HTMLDivElement>(null)
  useEffect(
    () =>
      subscribeConversation(
        window.electronAPI.conversations,
        sessionId,
        (next) => {
          setSnapshot(next)
          useSessionStore.setState((state) => ({
            sessions: state.sessions.map((session) =>
              session.id === sessionId
                ? {
                    ...session,
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
                        : session.claudeSessionId,
                    piSessionId:
                      next.session.provider === 'pi'
                        ? next.session.providerSessionId
                        : session.piSessionId,
                    alive: next.session.status !== 'closed'
                  }
                : session
            )
          }))
        },
        (failure) => setError(failure.message)
      ),
    [sessionId, retry]
  )
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'nearest' })
  }, [snapshot?.sequence])
  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      await action()
    } catch (failure) {
      setError(String(failure))
    } finally {
      setBusy(false)
    }
  }
  const send = (): void => {
    const text = draft.trim()
    if (!text) return
    const command =
      lastSend.current?.text === text ? lastSend.current : { text, commandId: crypto.randomUUID() }
    lastSend.current = command
    void run(async () => {
      await window.electronAPI.conversations.send(sessionId, command.text, command.commandId)
      lastSend.current = null
      setDraft('')
    })
  }
  const running = snapshot && ['starting', 'running', 'waiting'].includes(snapshot.session.status)
  return (
    <div
      className="flex flex-col h-full bg-surface-0"
      data-testid="conversation-panel"
      data-conversation-id={sessionId}
      onMouseDown={() => useSessionStore.getState().setFocusedSession(sessionId)}
    >
      <TerminalHeader sessionId={sessionId} />
      <div className="flex-1 min-h-0 overflow-auto p-3">
        {snapshot ? (
          <>
            <div className="text-xs text-text-secondary" data-testid="conversation-capabilities">
              {snapshot.session.provider} · {snapshot.session.status} · Provider fixed for this
              session
              <p>
                {snapshot.session.capabilities.permissions
                  ? 'Permission review available'
                  : 'Permission review not supported'}{' '}
                ·{' '}
                {snapshot.session.capabilities.questions
                  ? 'Questions supported'
                  : 'Questions not supported'}{' '}
                ·{' '}
                {snapshot.session.capabilities.resume ? 'Resume supported' : 'Resume not supported'}
              </p>
              {snapshot.session.capabilities.notice && (
                <p>{snapshot.session.capabilities.notice}</p>
              )}
            </div>
            {snapshot.entries.map((entry) =>
              entry.kind === 'message' ? (
                <article key={entry.id} aria-label={`${entry.role} message`} className="my-3">
                  <p className="text-xs text-text-secondary">
                    {entry.role === 'user' ? 'You' : snapshot.session.provider}
                  </p>
                  <MarkdownRenderer content={entry.text} />
                </article>
              ) : (
                <details key={entry.id} className="settings-card my-2 p-3">
                  <summary>
                    {entry.name} · {entry.status}
                  </summary>
                  {entry.input && (
                    <pre className="whitespace-pre-wrap break-words">{entry.input}</pre>
                  )}
                  {entry.output && (
                    <pre className="whitespace-pre-wrap break-words">{entry.output}</pre>
                  )}
                </details>
              )
            )}
            {snapshot.requests.map((request) => (
              <RequestControl
                key={request.id}
                request={request}
                busy={requestBusy}
                respond={(response) => {
                  setRequestBusy(true)
                  setError(undefined)
                  void window.electronAPI.conversations
                    .respond(sessionId, response)
                    .catch((failure) => setError(String(failure)))
                    .finally(() => setRequestBusy(false))
                }}
              />
            ))}
          </>
        ) : (
          <p>Connecting to conversation…</p>
        )}
        {(error || snapshot?.session.error) && (
          <div role="alert" className="settings-card p-3">
            <p>{error || snapshot?.session.error}</p>
            <button
              className="btn-secondary"
              onClick={() => {
                setError(undefined)
                setRetry((value) => value + 1)
              }}
            >
              Reconnect
            </button>
            {draft && (
              <button className="btn-primary" disabled={busy} onClick={send}>
                Retry send
              </button>
            )}
            {!draft && snapshot?.session.status === 'error' && (
              <button
                className="btn-primary"
                disabled={busy}
                onClick={() => {
                  const previous = snapshot.entries.findLast(
                    (entry) => entry.kind === 'message' && entry.role === 'user'
                  )
                  if (previous?.kind === 'message') {
                    void run(() =>
                      window.electronAPI.conversations.send(
                        sessionId,
                        previous.text,
                        crypto.randomUUID()
                      )
                    )
                  }
                }}
              >
                Retry turn
              </button>
            )}
          </div>
        )}
        <div ref={bottom} />
      </div>
      <form
        className="flex gap-2 p-3"
        onSubmit={(event) => {
          event.preventDefault()
          send()
        }}
      >
        <textarea
          className="textarea-field flex-1"
          aria-label="Message"
          placeholder="Message this agent"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        {running ? (
          <button
            className="panel-icon-btn"
            type="button"
            aria-label="Stop"
            onClick={() => {
              void run(() => window.electronAPI.conversations.interrupt(sessionId))
            }}
          >
            <StopIcon className="w-4 h-4" />
          </button>
        ) : (
          <button
            className="panel-icon-btn"
            aria-label="Send"
            disabled={busy || !draft.trim() || !snapshot || snapshot.session.status === 'closed'}
          >
            <ArrowUpIcon className="w-4 h-4" />
          </button>
        )}
      </form>
    </div>
  )
}
