import { describe, it, expect } from 'vitest'
import { decideAccountAction, type DecideInput } from './account-policy-rule'

const base: DecideInput = {
  alive: true,
  pinned: false,
  restarting: false,
  atLimit: true,
  working: false,
  mode: 'propose',
  nextAccountId: 'play',
  proposedId: null,
  dismissedId: null
}

/**
 * When a tab moves and when it only asks (ADR 0002). A wrong "switch" here
 * restarts an agent mid-turn; a wrong "none" leaves the user to find out at
 * the next turn.
 */
describe('decideAccountAction', () => {
  it('does nothing while the account has headroom, or the tab is dead, pinned or restarting', () => {
    expect(decideAccountAction({ ...base, atLimit: false })).toEqual({ kind: 'none' })
    expect(decideAccountAction({ ...base, alive: false })).toEqual({ kind: 'none' })
    expect(decideAccountAction({ ...base, pinned: true })).toEqual({ kind: 'none' })
    expect(decideAccountAction({ ...base, restarting: true })).toEqual({ kind: 'none' })
    expect(decideAccountAction({ ...base, mode: 'automatic', pinned: true })).toEqual({
      kind: 'none'
    })
  })

  it('does nothing when nowhere else has headroom', () => {
    expect(decideAccountAction({ ...base, nextAccountId: null })).toEqual({ kind: 'none' })
    expect(decideAccountAction({ ...base, mode: 'automatic', nextAccountId: null })).toEqual({
      kind: 'none'
    })
  })

  it('proposes by default, once per target, and not again after a dismissal', () => {
    expect(decideAccountAction(base)).toEqual({ kind: 'propose', accountId: 'play' })
    expect(decideAccountAction({ ...base, proposedId: 'play' })).toEqual({ kind: 'none' })
    expect(decideAccountAction({ ...base, dismissedId: 'play' })).toEqual({ kind: 'none' })
    // The pool moved on to another account: that one is proposed.
    expect(decideAccountAction({ ...base, dismissedId: 'play', nextAccountId: 'team' })).toEqual({
      kind: 'propose',
      accountId: 'team'
    })
  })

  it('switches automatically only once the agent is idle; a working tab gets the proposal', () => {
    expect(decideAccountAction({ ...base, mode: 'automatic' })).toEqual({
      kind: 'switch',
      accountId: 'play'
    })
    expect(decideAccountAction({ ...base, mode: 'automatic', working: true })).toEqual({
      kind: 'propose',
      accountId: 'play'
    })
    expect(decideAccountAction({ ...base, mode: 'propose', working: true })).toEqual({
      kind: 'propose',
      accountId: 'play'
    })
  })
})
