import type { BackgroundTask } from '../../../shared/session-model'
import { useConversationStore, type SessionLog } from './conversation-store'

const none: BackgroundTask[] = []

/**
 * What a session still has running in the background, read from its event
 * log: the last `background_tasks` snapshot, which replaces every earlier one.
 * A provider that has exited has nothing running, whatever it last said.
 */
export function latestBackgroundTasks(log: SessionLog | undefined): BackgroundTask[] {
  if (!log || log.exitCode !== undefined) return none
  for (let i = log.events.length - 1; i >= 0; i--) {
    const event = log.events[i].event
    if (event.type === 'background_tasks') return event.tasks.length ? event.tasks : none
  }
  return none
}

/** The session's background work, for as long as the host holds its log. */
export function useBackgroundTasks(sessionId: string): BackgroundTask[] {
  return useConversationStore((state) => latestBackgroundTasks(state.logs[sessionId]))
}
