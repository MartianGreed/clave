import { constants } from 'node:fs'
import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } from 'electron'
import { open } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import {
  attachmentSchema,
  MAX_IMAGE_BYTES,
  type AttachmentPreview
} from '../../shared/conversation-attachments'
import { prepareAttachment, readBounded } from '../conversations/attachments'

const sourceSchema = z.union([
  z.object({ path: z.string().min(1).max(4096) }).strict(),
  z
    .object({
      name: z.string().max(255),
      bytes: z.instanceof(Uint8Array).refine((bytes) => bytes.byteLength <= MAX_IMAGE_BYTES)
    })
    .strict()
])
export function registerConversationAttachmentHandlers(): void {
  ipcMain.handle('conversation:files', async (event, input: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error('Files require an application window.')
    const value = z
      .object({
        type: z.enum(['prepare', 'pick', 'preview', 'open']),
        sessionId: z
          .string()
          .regex(/^[a-zA-Z0-9-]{1,128}$/)
          .optional(),
        source: sourceSchema.optional(),
        file: attachmentSchema.optional()
      })
      .strict()
      .parse(input)
    if (value.type === 'pick') {
      const result = await dialog.showOpenDialog(win, {
        title: 'Add files to conversation',
        properties: ['openFile', 'multiSelections']
      })
      return result.canceled ? [] : result.filePaths
    }
    if (value.type === 'prepare') {
      if (!value.sessionId || !value.source) throw new Error('Missing attachment source.')
      return prepareAttachment(
        join(app.getPath('userData'), 'conversation-attachments', value.sessionId),
        value.source
      )
    }
    const file = value.file
    if (!file || !isAbsolute(file.path)) throw new Error('Missing local file.')
    if (value.type === 'open') {
      const error = await shell.openPath(file.path)
      if (error) throw new Error(error)
      return
    }
    const result: AttachmentPreview = {}
    if (file.mimeType.startsWith('image/') && file.mimeType !== 'image/svg+xml') {
      const bytes = await readBounded(file.path, MAX_IMAGE_BYTES)
      const image = nativeImage.createFromBuffer(bytes)
      if (image.isEmpty()) return { notice: 'Preview unavailable. Open the file to inspect it.' }
      const size = image.getSize()
      const scale = Math.min(1, 1200 / size.width, 900 / size.height)
      result.image = image
        .resize({
          width: Math.max(1, Math.floor(size.width * scale)),
          height: Math.max(1, Math.floor(size.height * scale))
        })
        .toDataURL()
    } else {
      const handle = await open(file.path, constants.O_RDONLY | constants.O_NONBLOCK)
      try {
        const info = await handle.stat()
        if (!info.isFile()) throw new Error('File is no longer available.')
        const bytes = Buffer.alloc(Math.min(info.size, 16 * 1024))
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
        const sample = bytes.subarray(0, bytesRead)
        if (file.mimeType === 'application/pdf' || sample.includes(0))
          result.notice = 'Open the file to view its contents.'
        else {
          result.text = sample.toString('utf8')
          if (info.size > bytesRead) result.notice = 'Showing the first 16 KiB.'
        }
      } finally {
        await handle.close()
      }
    }
    return result
  })
}
