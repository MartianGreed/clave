import { BrowserWindow, ipcMain } from 'electron'
import { z } from 'zod'
import { windowRegistry } from '../window-registry'
import { bringForward } from '../window-routing'
import { callRenderer } from '../mcp/mcp-bridge'
import {
  captureMessage,
  exchangeHistory,
  captureSessionState,
  captureTabClosed,
  captureTabSpawn
} from '../exchange-capture/service'
import type {
  MessageCapturePayload,
  SessionStateCapturePayload,
  TabClosedCapturePayload,
  TabSpawnCapturePayload
} from '../exchange-capture/types'

/** Capture IPC: fire-and-forget (`send`, not `invoke`) — capture is
 *  observability and must never delay or fail the delivery it records. The
 *  renderer owns every identity (name, cwd, group, model), so all four kinds
 *  arrive from it with their identities stamped; the main process adds only
 *  what lives on disk (usage snapshots, sidecar discovery). */
export function registerExchangeHandlers(): void {
  const request = z
    .object({
      sessionId: z.string().min(1).max(200),
      before: z.number().int().nonnegative().optional(),
      groupId: z.string().min(1).max(200).optional()
    })
    .strict()
  const trusted = (event: Electron.IpcMainInvokeEvent): void => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (
      !win ||
      event.senderFrame !== event.sender.mainFrame ||
      !windowRegistry.getKeyForWindow(win.id)
    )
      throw new Error('Exchange history requires the Clave host')
  }
  ipcMain.handle('exchange:history', (event, input) => {
    trusted(event)
    const { sessionId, before, groupId } = request.parse(input)
    return exchangeHistory(sessionId, before, groupId)
  })
  ipcMain.handle('exchange:open-session', async (event, input) => {
    trusted(event)
    const id = z.string().min(1).max(200).parse(input)
    const win = windowRegistry.getWindowForSession(id)
    if (!win || win.isDestroyed()) throw new Error('This session is no longer open')
    await callRenderer('focus', { sessionId: id }, win)
    bringForward(win)
  })
  ipcMain.on('exchange:capture-message', (_event, payload: MessageCapturePayload) => {
    captureMessage(payload)
  })
  ipcMain.on('exchange:capture-tab-spawn', (_event, payload: TabSpawnCapturePayload) => {
    captureTabSpawn(payload)
  })
  ipcMain.on('exchange:capture-session-state', (_event, payload: SessionStateCapturePayload) => {
    captureSessionState(payload)
  })
  ipcMain.on('exchange:capture-tab-closed', (_event, payload: TabClosedCapturePayload) => {
    captureTabClosed(payload)
  })
}
