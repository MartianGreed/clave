import type { Session } from '../store/session-types'

/** OpenCode has no .clave representation. Never downgrade it to a shell. */
export function assertPinnableSessions(
  sessions: Pick<Session, 'id' | 'claudeMode' | 'codexMode' | 'piMode'>[]
): void {
  if (
    sessions.some(
      (session) =>
        session.id.startsWith('conversation-') &&
        !session.claudeMode &&
        !session.codexMode &&
        !session.piMode
    )
  ) {
    throw new Error(
      'OpenCode sessions cannot be pinned or exported as .clave yet. Move the OpenCode tab out of this group before saving it.'
    )
  }
}
