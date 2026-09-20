import { useEffect, useReducer, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  ArrowUpIcon,
  ChatBubbleLeftRightIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ArrowPathIcon,
  ShieldCheckIcon,
  StopIcon
} from '@heroicons/react/24/outline'
import type {
  Session,
  SessionInput,
  AgentState,
  ModelOption
} from '../../../src/shared/session-model'
import { emptyConversation, reduceConversation, type Entry } from './reducer'
import { ChatCode } from './code'

export interface ChatViewProps {
  session: Session
  onState: (state: AgentState, model: string | null) => void
}
const stringify = (value: unknown): string =>
  typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? '')
/* The one line a closed tool row shows beside its name: the argument a
   human would recognise it by (the command, the path, the query), else the
   first string the input carries, else the input on one line. */
const SUMMARY_KEYS = ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'description']
function summarize(input: unknown): string {
  if (input === undefined || input === null) return ''
  if (typeof input === 'string') return input
  if (typeof input === 'object' && !Array.isArray(input)) {
    const record = input as Record<string, unknown>
    const key =
      SUMMARY_KEYS.find((k) => typeof record[k] === 'string' && record[k]) ??
      Object.keys(record).find((k) => typeof record[k] === 'string' && record[k])
    if (key) return String(record[key])
  }
  return JSON.stringify(input) ?? ''
}
// Only keep the transcript pinned to its end while the reader is already
// there; a reader who scrolled up to re-read is never yanked back down.
const STICK_THRESHOLD = 80
// The provider reports a full id (claude-opus-5-20260301); the menu lists the
// family (claude-opus-5). Either being a prefix of the other is the same model.
const sameModel = (reported: string | null, id: string): boolean =>
  reported === null
    ? id === 'default'
    : reported === id || reported.startsWith(id) || id.startsWith(reported)
/** The model chip on the composer's footer and the menu it opens above it. */
function ModelMenu({
  sessionId,
  model,
  disabled,
  onSelect
}: {
  sessionId: string
  model: string | null
  disabled: boolean
  onSelect: (id: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [options, setOptions] = useState<ModelOption[] | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  useEffect(() => {
    if (!open) return
    let live = true
    // A host older than this plugin has no sessionsModels: that is the menu's
    // failure to report, never the pane's to crash on, so the call is made
    // inside the chain where a missing method rejects instead of throwing.
    Promise.resolve()
      .then(() => window.electronAPI.sessionsModels(sessionId))
      .then((list) => {
        if (live) setOptions(list)
      })
      .catch((error) => {
        if (live) setFailure(String(error))
      })
    return () => {
      live = false
    }
  }, [open, sessionId])
  const current = options?.find((option) => sameModel(model, option.id))
  return (
    <DropdownMenu.Root
      modal={false}
      open={open}
      onOpenChange={(next) => {
        // Each opening asks the provider again, from a clean slate.
        if (next) setFailure(null)
        setOpen(next)
      }}
    >
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="chat-model-trigger"
          aria-label="Model"
          title="Change model"
          disabled={disabled}
        >
          <span className="chat-model-trigger-label">
            {current?.label ?? model ?? 'Default'}
          </span>
          <ChevronDownIcon />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="top"
          align="end"
          sideOffset={6}
          className="menu-surface menu-pop chat-model-menu z-50"
          aria-label="Models"
        >
          <DropdownMenu.Label className="menu-label">Select model</DropdownMenu.Label>
          {options === null && !failure && <div className="chat-model-empty">Loading…</div>}
          {failure && <div className="chat-model-empty">Models unavailable</div>}
          {options?.length === 0 && !failure && (
            <div className="chat-model-empty">This session offers no other model</div>
          )}
          {options?.map((option) => {
            const selected = sameModel(model, option.id)
            return (
              <DropdownMenu.Item
                key={option.id}
                className="menu-item chat-model-option"
                data-selected={selected ? 'true' : undefined}
                onSelect={() => onSelect(option.id)}
              >
                <span className="chat-model-option-text">
                  <span className="truncate">{option.label}</span>
                  {option.hint && <span className="chat-model-option-hint">{option.hint}</span>}
                </span>
                {selected && <CheckIcon className="select-option-check" />}
              </DropdownMenu.Item>
            )
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
export function ChatView({ session, onState }: ChatViewProps): React.JSX.Element {
  const [conversation, dispatch] = useReducer(reduceConversation, {
    ...emptyConversation,
    state: session.state
  })
  const [ready, setReady] = useState(false)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [pending, setPending] = useState<string[]>([])
  const scroll = useRef<HTMLDivElement>(null)
  const stuck = useRef(true)
  const textarea = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    let live = true
    const stop = window.electronAPI.onSessionStream(session.id, (value) => {
      if (value.kind === 'event') dispatch({ event: value.event })
    })
    const stopExit = window.electronAPI.onSessionStreamExit(session.id, (code) =>
      dispatch({ exit: code })
    )
    void window.electronAPI
      .sessionsSubscribe(session.id)
      .then(() => {
        if (live) setReady(true)
      })
      .catch((error) => dispatch({ event: { type: 'error', message: String(error), fatal: true } }))
    return () => {
      live = false
      stop()
      stopExit()
      void window.electronAPI.sessionsUnsubscribe(session.id)
    }
  }, [session.id])
  const waiting = conversation.entries.some((e) => e.kind === 'permission' && !e.answer)
  const state = conversation.state === 'ended' ? 'ended' : waiting ? 'blocked' : conversation.state
  useEffect(() => onState(state, conversation.model), [state, conversation.model, onState])
  useEffect(() => {
    const el = scroll.current
    if (el && stuck.current) el.scrollTop = el.scrollHeight
  }, [conversation.entries])
  const write = async (input: SessionInput): Promise<void> => {
    await window.electronAPI.sessionsWrite(session.id, input)
  }
  const report = (error: unknown): void =>
    dispatch({ event: { type: 'error', message: String(error), fatal: false } })
  const send = async (): Promise<void> => {
    if (!ready || sending || state === 'ended' || !draft.trim()) return
    const text = draft
    setSending(true)
    stuck.current = true
    try {
      await write({ type: 'user_message', text })
      setDraft((current) => (current === text ? '' : current))
    } catch (error) {
      report(error)
    } finally {
      setSending(false)
      textarea.current?.focus()
    }
  }
  const answer = async (id: string, optionId: string): Promise<void> => {
    setPending((current) => [...current, id])
    try {
      await write({ type: 'permission_response', id, optionId })
      dispatch({ answer: id, optionId })
    } catch (error) {
      report(error)
    } finally {
      setPending((current) => current.filter((value) => value !== id))
    }
  }
  const renderEntry = (entry: Entry, index: number): React.JSX.Element | null => {
    if (entry.kind === 'user')
      return (
        <article
          key={index}
          className="chat-turn"
          data-role="user"
          title={new Date(entry.at).toLocaleTimeString()}
        >
          {entry.text.replace(/\s+$/, '')}
        </article>
      )
    if (entry.kind === 'assistant')
      return (
        <article
          key={index}
          className="chat-turn chat-prose"
          data-role="assistant"
          data-final={entry.final}
          title={new Date(entry.at).toLocaleTimeString()}
        >
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              code: ChatCode,
              a: ({ href, children }) =>
                href && /^(https?:|mailto:)/i.test(href) ? (
                  <a
                    href={href}
                    onClick={(event) => {
                      event.preventDefault()
                      void window.electronAPI.openExternal(href).catch(report)
                    }}
                  >
                    {children}
                  </a>
                ) : (
                  <span>{children}</span>
                )
            }}
          >
            {entry.text}
          </ReactMarkdown>
        </article>
      )
    if (entry.kind === 'tool')
      return (
        <details key={index} className="chat-tool-card" data-complete={entry.complete}>
          <summary>
            <ChevronRightIcon className="chat-tool-chevron" />
            <span className="chat-tool-name">{entry.name ?? 'Tool'}</span>
            <span className="chat-tool-summary">{summarize(entry.input)}</span>
            {entry.complete ? (
              <CheckIcon className="chat-tool-status" aria-label="Complete" />
            ) : (
              <ArrowPathIcon className="chat-tool-status" data-running="true" aria-label="Running" />
            )}
          </summary>
          <div className="chat-card-body">
            <div className="chat-card-label">Input</div>
            <pre>{stringify(entry.input)}</pre>
            {entry.complete && (
              <>
                <div className="chat-card-label">Result</div>
                <pre>{stringify(entry.output)}</pre>
              </>
            )}
          </div>
        </details>
      )
    if (entry.kind === 'permission') {
      const chosen = entry.answer
        ? (entry.request.options.find((option) => option.id === entry.answer)?.label ??
          entry.answer)
        : null
      return (
        <section key={index} className="chat-permission-card" aria-label="Permission request">
          <div className="chat-permission-title">
            <ShieldCheckIcon />
            <span>Permission</span>
            {entry.request.toolName && <span className="badge">{entry.request.toolName}</span>}
          </div>
          <p>{entry.request.description}</p>
          {entry.request.input !== undefined && (
            <details className="chat-permission-input">
              <summary>
                <ChevronRightIcon className="chat-tool-chevron" />
                Input
              </summary>
              <pre>{stringify(entry.request.input)}</pre>
            </details>
          )}
          {chosen ? (
            <p className="chat-permission-answer" role="status">
              <CheckIcon />
              {chosen}
            </p>
          ) : (
            <div className="chat-actions">
              {entry.request.options.map((option, i) => (
                <button
                  key={option.id}
                  className={i === 0 ? 'btn-primary' : 'btn-secondary'}
                  disabled={!ready || pending.includes(entry.request.id) || state === 'ended'}
                  onClick={() => void answer(entry.request.id, option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          )}
        </section>
      )
    }
    if (entry.kind === 'error')
      return (
        <div key={index} className="chat-notice" data-tone="error" role="alert">
          {entry.message}
        </div>
      )
    return null
  }
  const closed = !ready || state === 'ended'
  return (
    <div className="chat-view" data-testid="chat-view">
      <div
        ref={scroll}
        className="chat-scroll"
        onScroll={(event) => {
          const el = event.currentTarget
          stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD
        }}
      >
        <div className="chat-column" role="log" aria-label="Conversation">
          {conversation.entries.length === 0 && state !== 'ended' && (
            <div className="chat-empty">
              <div className="chat-empty-icon">
                <ChatBubbleLeftRightIcon />
              </div>
              <div>
                <h2>Start a conversation</h2>
                <p>Ask a question or describe what you want to build.</p>
              </div>
            </div>
          )}
          {conversation.entries.map(renderEntry)}
          {state === 'ended' && (
            <div className="chat-notice" role="status">
              Session ended
              {conversation.exitCode !== undefined ? ` (exit ${conversation.exitCode})` : ''}
            </div>
          )}
        </div>
      </div>
      <div className="chat-composer-wrap">
        <form
          className="chat-composer"
          data-dragging={dragging}
          onSubmit={(event) => {
            event.preventDefault()
            void send()
          }}
          onDragOver={(event) => {
            event.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault()
            setDragging(false)
            const paths = Array.from(event.dataTransfer.files)
              .map((file) => window.electronAPI.getPathForFile(file))
              .filter(Boolean)
            if (paths.length) setDraft((current) => [current, ...paths].filter(Boolean).join('\n'))
          }}
        >
          <textarea
            ref={textarea}
            rows={1}
            aria-label="Message"
            placeholder={state === 'ended' ? 'This session has ended' : 'Write a message…'}
            value={draft}
            disabled={closed}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                void send()
              }
            }}
          />
          {state === 'working' ? (
            <button
              type="button"
              className="chat-send"
              data-kind="stop"
              aria-label="Interrupt"
              title="Interrupt"
              onClick={() => void write({ type: 'interrupt' }).catch(report)}
            >
              <StopIcon />
            </button>
          ) : (
            <button
              type="submit"
              className="chat-send"
              aria-label="Send message"
              title="Send (Enter)"
              disabled={closed || sending || !draft.trim()}
            >
              <ArrowUpIcon />
            </button>
          )}
        </form>
        <div className="chat-composer-footer">
          <span>Enter to send · Shift+Enter for a new line</span>
          <ModelMenu
            sessionId={session.id}
            model={conversation.model}
            disabled={closed}
            onSelect={(id) => void write({ type: 'set_model', model: id }).catch(report)}
          />
        </div>
      </div>
    </div>
  )
}
