import { describe, it, expect, vi } from 'vitest'

vi.mock('node-pty', () => ({ spawn: vi.fn() }))
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/clave-limits-test' },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('./mcp/mcp-runtime', () => ({
  getMcpRuntime: () => null,
  writeSessionMcpConfig: () => null,
  deleteSessionMcpConfig: () => undefined
}))

import { providerEventReportsLimit } from './pty-manager'

/**
 * The CLI's own word on its account's limit (ADR 0002): what turns a chat
 * stream frame into a proposal or a switch. A frame read as a limit that is
 * not one moves a tab for nothing; one missed leaves the user to find out at
 * the next turn.
 */
describe('providerEventReportsLimit', () => {
  it("reads Claude's rejected rate-limit event, and nothing else of Claude's", () => {
    expect(
      providerEventReportsLimit('claude', {
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', resetsAt: 1 }
      })
    ).toBe(true)
    expect(
      providerEventReportsLimit('claude', {
        type: 'rate_limit_event',
        rate_limit_info: { status: 'allowed_warning' }
      })
    ).toBe(false)
    expect(providerEventReportsLimit('claude', { type: 'system', subtype: 'init' })).toBe(false)
  })

  it("reads Codex's rate-limit update at the cap or with a reached type", () => {
    const frame = (rateLimits: unknown): unknown => ({
      method: 'account/rateLimits/updated',
      params: { rateLimits }
    })
    expect(providerEventReportsLimit('codex', frame({ primary: { usedPercent: 96 } }))).toBe(true)
    expect(
      providerEventReportsLimit(
        'codex',
        frame({ primary: { usedPercent: 40 }, rateLimitReachedType: 'weekly' })
      )
    ).toBe(true)
    expect(
      providerEventReportsLimit(
        'codex',
        frame({ primary: { usedPercent: 40 }, secondary: { usedPercent: 10 } })
      )
    ).toBe(false)
    expect(providerEventReportsLimit('codex', { method: 'thread/started', params: {} })).toBe(false)
  })

  it('is nothing for another provider, or a frame that is not an object', () => {
    expect(providerEventReportsLimit('pi', { type: 'rate_limit_event' })).toBe(false)
    expect(providerEventReportsLimit('claude', 'rate_limit_event')).toBe(false)
    expect(providerEventReportsLimit('codex', null)).toBe(false)
  })
})
