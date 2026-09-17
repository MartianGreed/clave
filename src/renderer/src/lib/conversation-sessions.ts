import type { ConversationSession } from '../../../shared/agent-session'
import type { Session } from '../store/session-types'
import { useSessionStore } from '../store/session-store'
import { getActiveWorkspaceId, getWorkspaceById } from '../store/workspace-store'

export function conversationToSession(session: ConversationSession): Session {
  const folderName = session.cwd.split(/[\\/]/).filter(Boolean).pop() || session.cwd
  return {
    id: session.id,
    cwd: session.cwd,
    folderName,
    name: session.title || `${session.provider} · ${folderName}`,
    alive: session.status !== 'closed',
    activityStatus: session.status === 'running' ? 'active' : 'idle',
    agentState:
      session.status === 'running' ? 'working' : session.status === 'waiting' ? 'blocked' : 'idle',
    promptWaiting: null,
    claudeMode: session.provider === 'claude',
    codexMode: session.provider === 'codex',
    piMode: session.provider === 'pi',
    antigravityMode: false,
    dangerousMode: session.dangerousMode ?? false,
    claudeSessionId: session.provider === 'claude' ? (session.providerSessionId ?? null) : null,
    piSessionId: session.provider === 'pi' ? session.providerSessionId : undefined,
    claudeProfileId: session.claudeProfileId,
    claudeConfigDir: session.configDir,
    launchProfileId: session.launchProfileId,
    model: session.model,
    workspaceId: session.workspaceId,
    sessionType: 'local',
    detectedUrl: null,
    serverStatus: null,
    serverCommand: null,
    hasUnseenActivity: false,
    userRenamed: Boolean(session.title),
    planFilePath: null
  }
}

/** Main returns only this window's sessions and adopts orphan homes into primary. */
export async function restoreConversations(): Promise<Set<string>> {
  const sessions = await window.electronAPI.conversations.list()
  const ids = new Set<string>()
  for (const session of sessions) {
    if (session.status === 'closed') continue
    ids.add(session.id)
    useSessionStore.getState().adoptSessionInPlace(conversationToSession(session))
  }
  return ids
}

/** OpenCode is deliberately direct-only, outside the pinned .clave schema. */
export async function launchOpenCode(groupId?: string): Promise<void> {
  const workspaceId = getActiveWorkspaceId()
  const cwd =
    getWorkspaceById(workspaceId)?.rootDir ?? (await window.electronAPI.openFolderDialog())
  if (!cwd) return
  const { session } = await window.electronAPI.conversations.create({
    provider: 'opencode',
    cwd,
    workspaceId: workspaceId ?? undefined
  })
  useSessionStore.getState().addSessionInGroup(conversationToSession(session), groupId ?? null)
}

export async function duplicateConversation(sessionId: string): Promise<string> {
  const { session: source } = await window.electronAPI.conversations.snapshot(sessionId)
  const { session } = await window.electronAPI.conversations.create({
    provider: source.provider,
    cwd: source.cwd,
    workspaceId: source.workspaceId,
    launchProfileId: source.launchProfileId,
    claudeProfileId: source.claudeProfileId,
    model: source.model,
    piProvider: source.piProvider,
    piThinking: source.piThinking,
    dangerousMode: source.dangerousMode
  })
  useSessionStore.getState().addSessionInGroup(conversationToSession(session), null)
  useSessionStore.getState().moveItems([session.id], sessionId, 'after')
  return session.id
}
