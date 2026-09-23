import { useEffect, useState } from 'react'
import {
  ChatBubbleLeftRightIcon,
  ArrowPathIcon,
  ArrowUpRightIcon
} from '@heroicons/react/24/outline'
import type {
  ExchangeHistoryMessage,
  ExchangeHistoryPage
} from '../../../../shared/exchange-history'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { useSessionStore } from '../../store/session-store'

export function ExchangeSessionLink({
  id,
  name,
  onOpen
}: {
  id: string
  name: string
  onOpen?: () => void
}): React.JSX.Element {
  const [error, setError] = useState<string | null>(null)
  return (
    <span className="exchange-session-link">
      <button
        className="panel-tab"
        title={`Open ${name}`}
        onClick={() => {
          setError(null)
          void window.electronAPI
            .openExchangeSession(id)
            .then(() => onOpen?.())
            .catch(() => setError('Session no longer open'))
        }}
      >
        {name}
        <ArrowUpRightIcon className="w-3 h-3" />
      </button>
      {error && <small role="status">{error}</small>}
    </span>
  )
}

export function ExchangeHistory({
  sessionId = '',
  groupId: fixedGroupId
}: {
  sessionId?: string
  groupId?: string
}): React.JSX.Element {
  const group = useSessionStore((state) =>
    state.groups.find((g) =>
      fixedGroupId ? g.id === fixedGroupId : g.sessionIds.includes(sessionId)
    )
  )
  const [open, setOpen] = useState(false)
  const [scope, setScope] = useState<'session' | 'group'>(fixedGroupId ? 'group' : 'session')
  const [page, setPage] = useState<ExchangeHistoryPage | null>(null)
  const [messages, setMessages] = useState<ExchangeHistoryMessage[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [cursor, setCursor] = useState<number | undefined>()
  const groupId = scope === 'group' ? group?.id : undefined
  const readSessionId = sessionId || group?.sessionIds[0] || 'group-view'
  useEffect(() => {
    if (!open) return
    let live = true
    void window.electronAPI
      .exchangeHistory({ sessionId: readSessionId, groupId, before: cursor })
      .then((next) => {
        if (!live) return
        setPage(next)
        setMessages((previous) =>
          cursor === undefined ? next.messages : [...previous, ...next.messages]
        )
      })
      .catch((e) => {
        if (live) setError(String(e))
      })
      .finally(() => {
        if (live) setBusy(false)
      })
    return () => {
      live = false
    }
  }, [open, readSessionId, groupId, cursor, refresh])
  const reset = (): void => {
    setBusy(true)
    setError(null)
    setCursor(undefined)
    setPage(null)
    setMessages([])
    setRefresh((n) => n + 1)
  }
  return (
    <Popover
      open={open}
      onOpenChange={(value) => {
        setOpen(value)
        if (value) reset()
      }}
    >
      <PopoverTrigger asChild>
        <button
          className="panel-icon-btn"
          aria-label="Communication history"
          title="Communication history"
        >
          <ChatBubbleLeftRightIcon className="w-4 h-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="exchange-history" aria-label="Communication history">
        <div className="exchange-history-heading">
          <h3>Communication history</h3>
          <button
            className="panel-icon-btn"
            aria-label="Refresh communication history"
            onClick={reset}
            disabled={busy}
          >
            <ArrowPathIcon className="w-4 h-4" />
          </button>
        </div>
        <div className="conversation-actions">
          {!fixedGroupId && (
            <button
              className="panel-tab"
              data-selected={scope === 'session'}
              aria-pressed={scope === 'session'}
              onClick={() => {
                setScope('session')
                reset()
              }}
            >
              This session
            </button>
          )}
          {group && (
            <button
              className="panel-tab"
              data-selected={scope === 'group'}
              aria-pressed={scope === 'group'}
              onClick={() => {
                setScope('group')
                reset()
              }}
            >
              {group.name}
            </button>
          )}
        </div>
        <p className="exchange-history-note">
          Messages and checkpoints captured by Clave. Newest first.
        </p>
        {error && <p role="alert">Could not load communication history. {error}</p>}
        <div className="exchange-history-messages">
          {!busy && !error && !messages.length && <p>No communications recorded yet.</p>}
          {messages.map((message, index) => (
            <article className="exchange-history-message" key={`${message.ts}:${index}`}>
              <div className="exchange-history-heading">
                <ExchangeSessionLink
                  id={message.sender.sessionId}
                  name={message.sender.name}
                  onOpen={() => setOpen(false)}
                />
                <span>{message.checkpoint ? 'checkpoint' : '→'}</span>
                {!message.checkpoint && (
                  <ExchangeSessionLink
                    id={message.target.sessionId}
                    name={message.target.name}
                    onOpen={() => setOpen(false)}
                  />
                )}
              </div>
              <small>
                {new Date(message.ts).toLocaleString()} ·{' '}
                {message.checkpoint
                  ? 'Logged only'
                  : message.delivered
                    ? 'Delivered'
                    : 'Not delivered'}
              </small>
              {(message.sender.groupName || message.target.groupName) && (
                <small>
                  {message.sender.groupName ?? 'Ungrouped'} →{' '}
                  {message.target.groupName ?? 'Ungrouped'}
                </small>
              )}
              <p className="conversation-user-text">{message.text}</p>
            </article>
          ))}
        </div>
        {page && page.skippedLines > 0 && (
          <p role="status">Some unreadable records were skipped.</p>
        )}
        {busy && <p role="status">Loading communications…</p>}
        {page?.before != null && (
          <button
            className="btn-secondary"
            disabled={busy}
            onClick={() => {
              setBusy(true)
              setError(null)
              setCursor(page.before!)
              setRefresh((n) => n + 1)
            }}
          >
            Load older
          </button>
        )}
      </PopoverContent>
    </Popover>
  )
}
