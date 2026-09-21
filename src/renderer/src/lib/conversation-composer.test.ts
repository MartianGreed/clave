import { describe, expect, it } from 'vitest'
import { ConversationComposer, shouldSendOnEnter, isNearLatest } from './conversation-composer'

function fixture(): ConversationComposer {
  const values = new Map<string, string>()
  return new ConversationComposer({
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value)
    },
    removeItem: (key) => {
      values.delete(key)
    }
  })
}

describe('conversation composer', () => {
  it('keeps unsaved edits in memory when browser storage is full', () => {
    let full = false
    const values = new Map<string, string>()
    const store = new ConversationComposer({
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        if (full) throw new Error('Quota exceeded')
        values.set(key, value)
      },
      removeItem: (key) => {
        values.delete(key)
      }
    })
    store.edit('one', 'original')
    const sent = store.begin('one')!
    full = true
    store.edit('one', 'next unsaved draft')
    store.accept('one', sent.commandId)
    store.storageChanged([...values.keys()][0])
    expect(store.read('one').text).toBe('next unsaved draft')
    expect(store.read('one').localOnly).toBe(true)
  })

  it.each(['accept', 'fail'] as const)(
    'preserves another window draft after a delayed %s',
    (outcome) => {
      const values = new Map<string, string>()
      const storage = {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => {
          values.set(key, value)
        },
        removeItem: (key: string) => {
          values.delete(key)
        }
      }
      const firstWindow = new ConversationComposer(storage)
      const secondWindow = new ConversationComposer(storage)
      firstWindow.edit('one', 'first prompt')
      const sent = firstWindow.begin('one')!
      secondWindow.edit('one', 'draft after moving the tab')
      const key = [...values.keys()][0]
      firstWindow.storageChanged(key)
      firstWindow[outcome]('one', sent.commandId)
      secondWindow.storageChanged(key)
      expect(secondWindow.read('one').text).toBe('draft after moving the tab')
    }
  )

  it('keeps each session draft independent and preserves whitespace', () => {
    const store = fixture()
    store.edit('one', '  indented code\n')
    store.edit('two', 'another prompt')
    expect(store.read('one').text).toBe('  indented code\n')
    expect(store.begin('one')?.text).toBe('  indented code\n')
    expect(store.read('two').text).toBe('another prompt')
  })

  it('does not erase edits made while the previous message is being accepted', () => {
    const store = fixture()
    store.edit('one', 'first prompt')
    const sent = store.begin('one')!
    store.edit('one', 'next prompt')
    store.accept('one', sent.commandId)
    expect(store.read('one').text).toBe('next prompt')
    expect(store.read('one').sending).toBe(false)
  })

  it('clears only the accepted revision and reuses a failed command ID on retry', () => {
    const store = fixture()
    store.edit('one', 'first prompt')
    const sent = store.begin('one')!
    expect(store.begin('one')).toBeNull()
    store.fail('one', sent.commandId)
    const retry = store.begin('one')!
    expect(retry.commandId).toBe(sent.commandId)
    store.accept('one', retry.commandId)
    expect(store.read('one').text).toBe('')
  })

  it('reloads drafts and uncertain command IDs without automatically resending', () => {
    const data = new Map<string, string>()
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        data.set(key, value)
      },
      removeItem: (key: string) => {
        data.delete(key)
      }
    }
    const first = new ConversationComposer(storage)
    first.edit('one', 'keep me')
    const sent = first.begin('one')!
    const restored = new ConversationComposer(storage)
    expect(restored.read('one').sending).toBe(false)
    expect(restored.read('one').text).toBe('keep me')
    expect(restored.begin('one')?.commandId).toBe(sent.commandId)
  })

  it('Enter sends, but Shift+Enter, IME, and Alt+Enter do not', () => {
    expect(shouldSendOnEnter({ key: 'Enter' })).toBe(true)
    expect(shouldSendOnEnter({ key: 'Enter', shiftKey: true })).toBe(false)
    expect(shouldSendOnEnter({ key: 'Enter', isComposing: true })).toBe(false)
    expect(shouldSendOnEnter({ key: 'Enter', altKey: true })).toBe(false)
    expect(shouldSendOnEnter({ key: 'a' })).toBe(false)
  })

  it('follows the bottom but not a reader further up the transcript', () => {
    expect(isNearLatest({ scrollHeight: 1200, scrollTop: 680, clientHeight: 500 })).toBe(true)
    expect(isNearLatest({ scrollHeight: 1200, scrollTop: 100, clientHeight: 500 })).toBe(false)
  })
})

describe('sent message recall', () => {
  it('walks session history in both directions, clamps oldest, and returns to empty', () => {
    const store = fixture()
    const messages = ['first', 'second\nline', 'second\nline']
    expect(store.recall('one', 'newer', messages)).toBe(false)
    expect(store.recall('one', 'older', messages)).toBe(true)
    expect(store.read('one').text).toBe('second\nline')
    store.recall('one', 'older', messages)
    store.recall('one', 'older', messages)
    store.recall('one', 'older', messages)
    expect(store.read('one').text).toBe('first')
    const revision = store.read('one').revision
    expect(store.recall('one', 'older', messages)).toBe(false)
    expect(store.read('one').revision).toBe(revision)
    for (let i = 0; i < 3; i++) store.recall('one', 'newer', messages)
    expect(store.read('one').text).toBe('')
    expect(store.recall('two', 'older', [])).toBe(false)
    expect(store.read('two').text).toBe('')
  })
  it('preserves drafts, including whitespace, and exits browsing on any edit', () => {
    const store = fixture()
    store.edit('one', ' ')
    expect(store.recall('one', 'older', ['sent'])).toBe(false)
    store.edit('one', '')
    store.recall('one', 'older', ['older', 'newest'])
    store.edit('one', 'newest edited')
    expect(store.recall('one', 'older', ['older', 'newest'])).toBe(false)
    expect(store.read('one').text).toBe('newest edited')
  })
  it('never replaces a pending send or uncertain retry, and recalled sends get new IDs', () => {
    const store = fixture()
    store.edit('one', 'sent')
    const command = store.begin('one')!
    expect(store.recall('one', 'older', ['older'])).toBe(false)
    store.fail('one', command.commandId)
    expect(store.recall('one', 'older', ['older'])).toBe(false)
    store.accept('one', command.commandId)
    store.recall('one', 'older', ['sent'])
    expect(store.begin('one')!.commandId).not.toBe(command.commandId)
  })
  it('does not shift a browsing position when the transcript gains a message', () => {
    const store = fixture()
    store.recall('one', 'older', ['first', 'last'])
    store.recall('one', 'older', ['first', 'last', 'arrived'])
    expect(store.read('one').text).toBe('first')
  })
})

const attachment = {
  id: 'file-one',
  path: '/project/index.ts',
  name: 'index.ts',
  mimeType: 'text/plain',
  size: 12,
  delivery: 'reference' as const
}
it('persists an attachment-only draft and includes it in a submission', () => {
  const store = fixture()
  store.edit('one', '', [attachment])
  expect(store.read('one').attachments).toEqual([attachment])
  expect(store.begin('one')?.attachments).toEqual([attachment])
})
it('recalls attachments with text but never replaces newly attached files', () => {
  const store = fixture()
  store.edit('one', '', [attachment])
  expect(store.recall('one', 'older', [{ text: 'old', attachments: [] }])).toBe(false)
  store.clear('one')
  expect(store.recall('one', 'older', [{ text: 'old', attachments: [attachment] }])).toBe(true)
  expect(store.read('one')).toMatchObject({ text: 'old', attachments: [attachment] })
  expect(store.recall('one', 'newer', [])).toBe(true)
  expect(store.read('one')).toMatchObject({ text: '', attachments: [] })
})
it('uses a fresh command when attachments change after a failed send', () => {
  const store = fixture()
  store.edit('one', 'inspect', [attachment])
  const first = store.begin('one')!
  store.fail('one', first.commandId)
  store.edit('one', 'inspect', [{ ...attachment, id: 'two', path: '/project/other.ts' }])
  expect(store.begin('one')!.commandId).not.toBe(first.commandId)
})
it('restores attachment drafts and pending submission IDs across restart', () => {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    }
  }
  const first = new ConversationComposer(storage)
  first.edit('one', '', [attachment])
  const command = first.begin('one')!
  const restored = new ConversationComposer(storage)
  expect(restored.read('one').attachments).toEqual([attachment])
  expect(restored.begin('one')?.commandId).toBe(command.commandId)
  restored.accept('one', command.commandId)
  expect(restored.read('one').attachments).toEqual([])
})
it('does not send incomplete preparations or resurrect a removed pending file', () => {
  const store = fixture()
  store.edit('one', 'draft')
  const key = store.prepare('one', 'index.ts')!
  expect(store.begin('one')).toBeNull()
  store.removePreparation('one', key)
  store.prepared('one', key, attachment)
  expect(store.read('one').attachments).toEqual([])
  expect(store.begin('one')?.text).toBe('draft')
})
it('keeps files added while a message is being accepted', () => {
  const store = fixture()
  store.edit('one', '', [attachment])
  const sent = store.begin('one')!
  const next = { ...attachment, id: 'two', path: '/other.ts' }
  store.edit('one', 'next', [next])
  store.accept('one', sent.commandId)
  expect(store.read('one')).toMatchObject({ text: 'next', attachments: [next] })
})
it('settling an earlier send keeps a live file preparation pending', () => {
  const store = fixture()
  store.edit('one', 'first')
  const sent = store.begin('one')!
  const key = store.prepare('one', 'code.ts')!
  store.accept('one', sent.commandId)
  expect(store.read('one').preparations).toEqual([{ id: key, name: 'code.ts' }])
  store.prepared('one', key, attachment)
  expect(store.read('one').attachments).toEqual([attachment])
})
