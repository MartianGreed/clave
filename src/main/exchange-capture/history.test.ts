import { afterEach, expect, it } from 'vitest'
import { mkdtemp, writeFile, rm, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readExchangeHistory } from './history'
import type { ExchangeHistoryEndpoint } from '../../shared/exchange-history'
const directories: string[] = []
const endpoint = (id: string, group = id): ExchangeHistoryEndpoint => ({
  sessionId: id,
  name: id,
  groupId: group,
  groupName: group
})
const message = (
  text: string,
  sender = endpoint('lane', 'work'),
  target = endpoint('wave')
): Record<string, unknown> => ({
  kind: 'message',
  ts: '2026-09-23T00:00:00Z',
  sender,
  target,
  text,
  delivered: true
})
async function file(lines: unknown[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'clave-exchanges-'))
  directories.push(dir)
  const path = join(dir, 'events.jsonl')
  await writeFile(path, lines.map((line) => JSON.stringify(line)).join('\n') + '\n')
  return path
}
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true })
})
it('reads both directions, checkpoints and group traffic without leaking other groups', async () => {
  const path = await file([
    message('question'),
    message('answer', endpoint('wave'), endpoint('lane', 'work')),
    message('private', endpoint('elsewhere'), endpoint('someone')),
    message('checkpoint', endpoint('lane', 'work'), endpoint('lane', 'work')),
    message('sibling', endpoint('sibling', 'work'))
  ])
  expect((await readExchangeHistory(path, 'lane')).messages.map((m) => m.text)).toEqual([
    'checkpoint',
    'answer',
    'question'
  ])
  const page = await readExchangeHistory(path, 'lane', undefined, 'work')
  expect(page.messages.map((m) => m.text)).toEqual(['sibling', 'checkpoint', 'answer', 'question'])
  expect(page.messages[1].checkpoint).toBe(true)
  expect(page.before).toBeNull()
})
it('paginates without duplicates when new messages arrive, and survives a new reader', async () => {
  const path = await file(Array.from({ length: 130 }, (_, i) => message(String(i))))
  const first = await readExchangeHistory(path, 'lane')
  expect(first.messages).toHaveLength(100)
  await appendFile(path, JSON.stringify(message('new')) + '\n')
  const next = await readExchangeHistory(path, 'lane', first.before!)
  expect(next.messages.map((m) => m.text)).toEqual(
    Array.from({ length: 30 }, (_, i) => String(29 - i))
  )
  expect(next.before).toBeNull()
})
it('reports corrupt records, accepts blank lines and missing files, rejects invalid cursors', async () => {
  const path = await file([message('kept')])
  await appendFile(path, '\nnot json\n{"kind":"message"}\n')
  const page = await readExchangeHistory(path, 'lane')
  expect(page.messages.map((m) => m.text)).toEqual(['kept'])
  expect(page.skippedLines).toBe(2)
  expect((await readExchangeHistory(path + '-missing', 'lane')).messages).toEqual([])
  await expect(readExchangeHistory(path, 'lane', -1)).rejects.toThrow('Invalid history cursor')
})
it('preserves records straddling the scan boundary', async () => {
  const path = await file([
    message('oldest'),
    ...Array.from({ length: 1100 }, (_, i) =>
      message('x'.repeat(8000) + i, endpoint('other'), endpoint('unrelated'))
    ),
    message('latest')
  ])
  const first = await readExchangeHistory(path, 'lane')
  expect(first.messages.map((m) => m.text)).toEqual(['latest'])
  expect(first.before).not.toBeNull()
  const second = await readExchangeHistory(path, 'lane', first.before!)
  expect(second.messages.map((m) => m.text)).toEqual(['oldest'])
  expect(second.skippedLines).toBe(0)
})

it('advances past an oversized line instead of returning the same cursor forever', async () => {
  const path = await file([
    message('kept'),
    { kind: 'oversized', data: 'x'.repeat(9 * 1024 * 1024) }
  ])
  const page = await readExchangeHistory(path, 'lane')
  expect(page.skippedLines).toBe(1)
  expect(page.before).toBeGreaterThan(0)
  const next = await readExchangeHistory(path, 'lane', page.before!)
  expect(next.before).toBeNull()
  expect(next.messages.map((m) => m.text)).toEqual(['kept'])
})
