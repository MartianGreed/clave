import { open } from 'node:fs/promises'
import { z } from 'zod'
import type { ExchangeHistoryPage } from '../../shared/exchange-history'

const endpoint = z.object({
  sessionId: z.string(),
  name: z.string(),
  groupId: z.string().nullable(),
  groupName: z.string().nullable()
})
const message = z.object({
  kind: z.literal('message'),
  ts: z.string(),
  sender: endpoint,
  target: endpoint,
  text: z.string(),
  delivered: z.boolean()
})
const MAX_SCAN = 8 * 1024 * 1024
const MAX_TEXT = 512 * 1024

/** Bounded reads, newest first. Cursor advances even through unrelated or corrupt lines. */
export async function readExchangeHistory(
  file: string,
  sessionId: string,
  before?: number,
  groupId?: string
): Promise<ExchangeHistoryPage> {
  const result: ExchangeHistoryPage = { messages: [], before: null, skippedLines: 0 }
  const handle = await open(file, 'r').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!handle) return result
  try {
    const size = (await handle.stat()).size
    const end = Math.min(before ?? size, size)
    if (!Number.isSafeInteger(end) || end < 0) throw new Error('Invalid history cursor')
    const start = Math.max(0, end - MAX_SCAN)
    const buffer = Buffer.alloc(end - start)
    await handle.read(buffer, 0, buffer.length, start)
    let right = buffer.length
    let bytes = 0
    while (right > 0) {
      if (buffer[right - 1] === 10) right--
      if (right === 0) {
        result.before = start || null
        break
      }
      const left = buffer.lastIndexOf(10, right - 1) + 1
      if (left === 0 && start > 0) {
        result.before = right + 1 < buffer.length ? start + right + 1 : start
        if (right + 1 >= buffer.length) result.skippedLines++
        break
      }
      const raw = buffer.subarray(left, right)
      result.before = start + left || null
      right = left
      if (!raw.length) continue
      try {
        const parsed = JSON.parse(raw.toString('utf8'))
        if (parsed.kind !== 'message') continue
        const event = message.parse(parsed)
        if (
          ![event.sender, event.target].some((e) =>
            groupId ? e.groupId === groupId : e.sessionId === sessionId
          )
        )
          continue
        bytes += raw.length
        result.messages.push({
          ts: event.ts,
          sender: event.sender,
          target: event.target,
          text: event.text,
          delivered: event.delivered,
          checkpoint: event.sender.sessionId === event.target.sessionId
        })
        if (result.messages.length >= 100 || bytes >= MAX_TEXT) break
      } catch {
        result.skippedLines++
      }
    }
    return result
  } finally {
    await handle.close()
  }
}
