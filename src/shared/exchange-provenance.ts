/**
 * The provenance header Clave stamps on every cross-tab message delivery, and
 * the matcher that recognizes it again in a session's transcript.
 *
 * The renderer builds the header when delivering a message; transcript cards
 * and composer recall recognize it with the same module. Exos reads the
 * transport record. Keep construction and recognition together so a header
 * change cannot silently present a sibling agent's message as human input.
 */

/** Sender identity as it appears in a named header. */
export interface ProvenanceSender {
  id: string
  name: string
}

/** The invariant opening of a named header — the part interpolation cannot
 *  change, and therefore the part a matcher can rely on. */
export const NAMED_PROVENANCE_PREFIX = '[Message from Clave tab "'

/** Header used when the sending side has no tab identity. */
export const ANONYMOUS_PROVENANCE_HEADER = '[Message from a Clave agent]'

/** Build the provenance header for a delivery. The receiving agent must be
 *  able to tell the text came from a sibling tab, not from the user, and know
 *  how to answer it — hence the reply instruction carrying the sender's id. */
export function buildProvenanceHeader(sender: ProvenanceSender | undefined): string {
  if (!sender) return ANONYMOUS_PROVENANCE_HEADER
  return `${NAMED_PROVENANCE_PREFIX}${sender.name}" — reply with clave_send_to_session sessionId="${sender.id}"]`
}

/** The invariant opening of a checkpoint header — a self-addressed send,
 *  logged into the transport record, never delivered anywhere. */
export const CHECKPOINT_PROVENANCE_PREFIX = '[Checkpoint by Clave tab "'

/** Header used when the checkpointing side has no tab identity. */
export const ANONYMOUS_CHECKPOINT_HEADER = '[Checkpoint by a Clave agent — logged, not delivered]'

/**
 * Build the provenance stamped on a CHECKPOINT: a self-addressed send that is
 * logged, never delivered (the solo lane's internal note). Deliberately NOT
 * matched by `hasProvenanceHeader`: a checkpoint never appears in any
 * transcript, and the matcher's delivered-message semantics must stay exact.
 */
export function buildCheckpointProvenance(sender: ProvenanceSender | undefined): string {
  if (!sender) return ANONYMOUS_CHECKPOINT_HEADER
  return `${CHECKPOINT_PROVENANCE_PREFIX}${sender.name}" — logged, not delivered]`
}

/**
 * True when `text` arrived through clave_send_to_session — i.e. it is a
 * sibling agent's message that the transcript happens to store on the user
 * side, not something the human wrote.
 */
export function hasProvenanceHeader(text: string): boolean {
  return parseProvenanceMessage(text) !== null
}

/** Presentation hint for existing transcripts, never an authorization credential. */
export function parseProvenanceMessage(text: string): {
  sender: ProvenanceSender | null
  body: string
} | null {
  const trimmed = text.trimStart()
  const newline = trimmed.indexOf('\n')
  const header = (newline < 0 ? trimmed : trimmed.slice(0, newline)).trimEnd()
  const body = newline < 0 ? '' : trimmed.slice(newline + 1)
  if (header === ANONYMOUS_PROVENANCE_HEADER) return { sender: null, body }
  const match =
    /^\[Message from Clave tab "(.*)" — reply with clave_(?:send_to_session|message) sessionId="([^"\r\n]+)"\]$/.exec(
      header
    )
  return match ? { sender: { name: match[1], id: match[2] }, body } : null
}
