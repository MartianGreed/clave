import { createConnection, type Socket } from 'node:net'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SESSION_PROTOCOL_VERSION,
  type ConversationOptions,
  type ConversationSnapshot,
  type ConversationSession,
  type ConversationEnvelope,
  type AgentResponse
} from '../../shared/agent-session'
import type { AdapterLaunch } from './adapter'
import { servicePaths, receive, transmit, type ServiceCommand } from './wire'

interface ClientOptions {
  userData: string
  daemonPath?: string
  executablePath?: string
}

export class ConversationClient {
  private nextId = 0
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >()
  private listeners = new Set<(event: ConversationEnvelope) => void>()
  private constructor(private socket: Socket) {
    socket.on('error', () => {})
    socket.on('close', () => {
      for (const request of this.pending.values()) {
        clearTimeout(request.timer)
        request.reject(
          new Error('Conversation service disconnected; command outcome may be unknown')
        )
      }
      this.pending.clear()
    })
  }

  static async connect(options: ClientOptions): Promise<ConversationClient> {
    const paths = servicePaths(options.userData)
    let spawned = false
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        const token = readFileSync(paths.token, 'utf8')
        return await this.attach(paths.socket, token)
      } catch (error) {
        if ((error as Error).message === 'Conversation protocol mismatch') throw error
        if (!spawned) {
          spawned = true
          const child = spawn(
            options.executablePath ?? process.execPath,
            [
              options.daemonPath ?? join(__dirname, 'conversation-daemon.js'),
              '--conversation-daemon',
              options.userData
            ],
            { detached: true, stdio: 'ignore', env: daemonEnvironment() }
          )
          child.on('error', () => {})
          child.unref()
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
    throw new Error('Could not connect to the conversation service')
  }

  static attach(path: string, token: string): Promise<ConversationClient> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(path)
      const client = new ConversationClient(socket)
      let ready = false
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error('Conversation handshake timed out'))
      }, 2000)
      socket.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      socket.once('close', () => {
        clearTimeout(timer)
        if (!ready) reject(new Error('Conversation handshake rejected'))
      })
      socket.once('connect', () => transmit(socket, { hello: SESSION_PROTOCOL_VERSION, token }))
      receive(socket, (message) => {
        if (!ready) {
          if (!('ready' in message) || message.ready !== SESSION_PROTOCOL_VERSION) {
            clearTimeout(timer)
            socket.destroy()
            reject(new Error('Conversation protocol mismatch'))
            return
          }
          ready = true
          clearTimeout(timer)
          resolve(client)
        } else if ('event' in message) {
          for (const listener of client.listeners) {
            try {
              listener(message.event)
            } catch {
              /* independent subscribers */
            }
          }
        } else if ('id' in message && !('command' in message)) {
          const request = client.pending.get(message.id)
          if (!request) return
          client.pending.delete(message.id)
          clearTimeout(request.timer)
          if (message.error) request.reject(new Error(message.error))
          else request.resolve(message.result)
        }
      })
    })
  }

  private request<T>(command: ServiceCommand, launch?: AdapterLaunch): Promise<T> {
    if (this.socket.destroyed) return Promise.reject(new Error('Conversation service disconnected'))
    if (this.pending.size >= 64) return Promise.reject(new Error('Too many conversation requests'))
    const id = ++this.nextId
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(
          new Error('Conversation command timed out; outcome may be unknown. It was not replayed.')
        )
      }, 30000)
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer })
      transmit(this.socket, { id, command, launch })
    })
  }
  create(options: ConversationOptions, launch: AdapterLaunch): Promise<ConversationSnapshot> {
    return this.request({ type: 'create', options }, launch)
  }
  list(): Promise<ConversationSession[]> {
    return this.request({ type: 'list' })
  }
  snapshot(sessionId: string): Promise<ConversationSnapshot> {
    return this.request({ type: 'snapshot', sessionId })
  }
  send(sessionId: string, text: string, commandId: string, launch?: AdapterLaunch): Promise<void> {
    return this.request({ type: 'send', sessionId, text, commandId }, launch)
  }
  interrupt(sessionId: string): Promise<void> {
    return this.request({ type: 'interrupt', sessionId })
  }
  respond(sessionId: string, response: AgentResponse): Promise<void> {
    return this.request({ type: 'respond', sessionId, response })
  }
  close(sessionId: string): Promise<void> {
    return this.request({ type: 'close', sessionId })
  }
  updateMetadata(
    sessionId: string,
    metadata: { title?: string; workspaceId?: string | null; windowKey?: string }
  ): Promise<void> {
    return this.request({ type: 'update-metadata', sessionId, metadata })
  }
  onEvent(callback: (event: ConversationEnvelope) => void): () => void {
    this.listeners.add(callback)
    return () => {
      this.listeners.delete(callback)
    }
  }
  isConnected(): boolean {
    return !this.socket.destroyed && this.socket.writable
  }
  disconnect(): void {
    this.socket.destroy()
    this.listeners.clear()
  }
}

function daemonEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1' }
  for (const key of [
    'HOME',
    'USERPROFILE',
    'PATH',
    'SystemRoot',
    'WINDIR',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG'
  ]) {
    if (process.env[key]) env[key] = process.env[key]
  }
  return env
}
