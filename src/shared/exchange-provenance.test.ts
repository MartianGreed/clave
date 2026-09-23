/**
 * The provenance contract's one dangerous edge: the checkpoint header (a
 * self-addressed send, logged, never delivered) must NEVER be matched by
 * `hasProvenanceHeader`, whose semantics are "this text was DELIVERED into a
 * transcript by a sibling". A checkpoint matching it would let a pasted
 * checkpoint body relabel human text as a sibling's message.
 */
import { describe, expect, it } from 'vitest'
import {
  ANONYMOUS_CHECKPOINT_HEADER,
  buildCheckpointProvenance,
  buildProvenanceHeader,
  hasProvenanceHeader,
  parseProvenanceMessage
} from './exchange-provenance'

describe('buildCheckpointProvenance', () => {
  it('names the tab and says logged, not delivered', () => {
    expect(buildCheckpointProvenance({ id: 'abc', name: 'Exos' })).toBe(
      '[Checkpoint by Clave tab "Exos" — logged, not delivered]'
    )
    expect(buildCheckpointProvenance(undefined)).toBe(ANONYMOUS_CHECKPOINT_HEADER)
  })

  it('is never matched by hasProvenanceHeader, while delivery headers still are', () => {
    expect(hasProvenanceHeader(buildCheckpointProvenance({ id: 'abc', name: 'Exos' }))).toBe(false)
    expect(hasProvenanceHeader(buildCheckpointProvenance(undefined))).toBe(false)
    expect(hasProvenanceHeader(buildProvenanceHeader({ id: 'abc', name: 'Exos' }))).toBe(true)
    expect(hasProvenanceHeader(buildProvenanceHeader(undefined))).toBe(true)
  })
})

// A prefix in ordinary prose is not a delivered message.
it('does not classify an incomplete or embedded header as a cross-tab message', () => {
  expect(hasProvenanceHeader('[Message from Clave tab "example')).toBe(false)
  expect(hasProvenanceHeader('Example: [Message from a Clave agent]')).toBe(false)
})

it('extracts the source and preserves the message body including further headers', () => {
  const header = buildProvenanceHeader({ id: 'conversation-abc', name: 'Lane "one"' })
  expect(parseProvenanceMessage(`${header}\nQUESTION\n${header}`)).toEqual({
    sender: { id: 'conversation-abc', name: 'Lane "one"' },
    body: `QUESTION\n${header}`
  })
  expect(parseProvenanceMessage('[Message from a Clave agent]\nHello')).toEqual({
    sender: null,
    body: 'Hello'
  })
})
