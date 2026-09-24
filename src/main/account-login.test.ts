import { describe, it, expect, vi } from 'vitest'

vi.mock('node-pty', () => ({ spawn: vi.fn() }))
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/clave-login-test' },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('./mcp/mcp-runtime', () => ({
  getMcpRuntime: () => null,
  writeSessionMcpConfig: () => null,
  deleteSessionMcpConfig: () => undefined
}))

import { findClaudeToken, findLoginUrl, stripAnsi } from './account-login'

/**
 * The login runs in a hidden PTY (ADR 0002): what the user sees is what
 * these three read out of its output. A missed link is a login the user
 * cannot finish; a missed token is a login that "worked" and stored nothing.
 */
describe('the login output readers', () => {
  it('strips colours, cursor moves, title changes and carriage returns', () => {
    expect(stripAnsi('\x1b[1mBold\x1b[0m \x1b]0;title\x07 line\r\n')).toBe('Bold  line\n')
    expect(stripAnsi('\x1b[2K\x1b[1Gprompt> ')).toBe('prompt> ')
  })

  it('finds the link the CLI printed, without the punctuation after it', () => {
    expect(
      findLoginUrl(
        'Opening your browser…\nIf it did not open, visit:\n  https://claude.ai/oauth/authorize?code=true&client_id=abc.\n'
      )
    ).toBe('https://claude.ai/oauth/authorize?code=true&client_id=abc')
    expect(
      findLoginUrl('navigate to http://localhost:1455/auth/callback?x=1 to authenticate')
    ).toBe('http://localhost:1455/auth/callback?x=1')
    expect(findLoginUrl('Starting local login server')).toBeNull()
  })

  it('finds the token by its shape and nothing shorter', () => {
    const token = 'sk-ant-oat01-' + 'a'.repeat(40)
    expect(findClaudeToken(`Your token:\n\n${token}\n\nKeep it safe.`)).toBe(token)
    expect(findClaudeToken('sk-ant-short')).toBeNull()
    expect(findClaudeToken('Run claude setup-token to get one')).toBeNull()
  })
})
