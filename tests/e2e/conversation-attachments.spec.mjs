import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO, launchApp, seedWorkspaces, callMcp, until } from './harness.mjs'

const ID = 'conversation-attachments-one'
const OTHER = 'conversation-attachments-two'
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGUlEQVR4nGPwrn32nxLMMGrAqAGjBgwXAwB7Aq0fO8+5wwAAAABJRU5ErkJggg=='

async function stopOwnedService(userData, t) {
  const owner = join(userData, 'conversation-service/owner.json')
  if (!existsSync(owner)) return
  const { pid } = JSON.parse(readFileSync(owner, 'utf8'))
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    /* Already stopped. */
  }
  t.check(
    'test-owned attachment service stops',
    await until(
      () => {
        try {
          process.kill(pid, 0)
          return false
        } catch {
          return true
        }
      },
      { tries: 50, gapMs: 100 }
    )
  )
}

export async function run(t) {
  const directory = mkdtempSync(join(REPO, '.conversation-attachments-'))
  const root = join(directory, 'project')
  const userData = join(directory, 'app')
  mkdirSync(root)
  const code = join(root, 'example.ts')
  writeFileSync(code, 'export const answer = 42\n')
  const svg = join(root, 'unsupported.svg')
  writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg"/>')
  seedWorkspaces(userData, {
    workspaces: [{ id: 'attachments', name: 'Attachments', rootDir: root, createdAt: 1 }],
    activeWorkspaceId: 'attachments',
    fresh: true
  })
  let app
  try {
    const launched = await launchApp(userData)
    app = launched.app
    const win = launched.win
    win.setDefaultTimeout(6000)
    await app.evaluate(
      ({ ipcMain, BrowserWindow }, { root, ids }) => {
        const fixture = (globalThis.__attachments = { calls: [], snapshots: {} })
        for (const [index, id] of ids.entries())
          fixture.snapshots[id] = {
            session: {
              id,
              provider: index ? 'custom.text-only' : 'claude',
              title: `Attachment session ${index + 1}`,
              cwd: root,
              workspaceId: 'attachments',
              status: 'idle',
              createdAt: '',
              updatedAt: '',
              capabilities: { permissions: true, questions: true, resume: true, images: !index }
            },
            sequence: 0,
            entries: [],
            requests: []
          }
        ipcMain.removeHandler('conversation:command')
        ipcMain.handle('conversation:command', (_event, command) => {
          fixture.calls.push(command)
          if (command.type === 'list') return Object.values(fixture.snapshots).map((s) => s.session)
          const snapshot = fixture.snapshots[command.sessionId]
          if (command.type === 'snapshot') return snapshot
          if (command.type === 'send') {
            const message = {
              kind: 'message',
              id: command.commandId,
              role: 'user',
              text: command.text,
              attachments: command.attachments
            }
            snapshot.entries.push(message)
            for (const window of BrowserWindow.getAllWindows())
              window.webContents.send('conversation:event', {
                sessionId: command.sessionId,
                sequence: ++snapshot.sequence,
                timestamp: '',
                event: { type: 'message', message }
              })
          }
        })
      },
      { root, ids: [ID, OTHER] }
    )
    await win.reload()
    await win.waitForLoadState('domcontentloaded')
    await win.locator('[data-testid="conversation-panel"]').first().waitFor()
    await callMcp(app, 'focus', { sessionId: ID })
    const panel = win.locator(`[data-conversation-id="${ID}"]`)
    await panel.waitFor()
    const input = panel.getByRole('textbox', { name: 'Message', exact: true })
    const files = panel.getByRole('list', { name: 'Attached files', exact: true })
    const send = panel.getByRole('button', { name: 'Send', exact: true })
    const drop = async (target, paths, phase = 'drop') =>
      target.evaluate(
        (el, { paths, phase }) => {
          const dataTransfer = new DataTransfer()
          dataTransfer.setData(
            'text/uri-list',
            paths.map((path) => `file://${encodeURI(path)}`).join('\n')
          )
          el.dispatchEvent(new DragEvent(phase, { dataTransfer, bubbles: true, cancelable: true }))
        },
        { paths, phase }
      )
    await input.fill('Keep my draft')
    await drop(panel, [code], 'dragenter')
    t.check(
      'file drag identifies the target conversation',
      await panel.getByText('Add files to this conversation').isVisible()
    )
    if (process.env.CLAVE_CAPTURE_ATTACHMENTS)
      await panel.screenshot({ path: '/tmp/clave-attachments-drop.png' })
    await drop(panel, [code])
    await files.getByRole('button', { name: 'Preview example.ts' }).waitFor()
    t.equal('drop preserves the draft', await input.inputValue(), 'Keep my draft')
    t.equal(
      'drop does not send',
      await app.evaluate(
        () => globalThis.__attachments.calls.filter((c) => c.type === 'send').length
      ),
      0
    )
    t.equal('drop overlay clears', await panel.locator('.conversation-drop-overlay').count(), 0)
    await files.getByRole('button', { name: 'Preview example.ts' }).click()
    await win.getByRole('dialog').getByText('export const answer = 42', { exact: false }).waitFor()
    t.check('file chip opens a content preview', await win.getByRole('dialog').isVisible())
    await win.getByRole('button', { name: 'Close preview' }).click()
    await drop(panel, [code])
    await until(async () => !(await panel.getByRole('list', { name: 'Preparing files' }).count()))
    await files.getByRole('button', { name: 'Preview example.ts' }).waitFor()
    t.equal(
      'duplicate stable path is not attached twice',
      await files.getByRole('button', { name: 'Preview example.ts' }).count(),
      1
    )
    await input.fill('')
    await input.press('ArrowUp')
    t.equal(
      'history does not replace staged files',
      await files.getByRole('button', { name: 'Preview example.ts' }).count(),
      1
    )
    await callMcp(app, 'focus', { sessionId: OTHER })
    const other = win.locator(`[data-conversation-id="${OTHER}"]`)
    await other.waitFor()
    t.equal(
      'files belong only to the target session',
      await other.getByRole('list', { name: 'Attached files', exact: true }).count(),
      0
    )
    await callMcp(app, 'focus', { sessionId: ID })
    await win.reload()
    await panel.waitFor()
    await files.getByRole('button', { name: 'Preview example.ts' }).waitFor()
    t.check('attachment-only draft survives reload', await send.isEnabled())
    await send.click()
    const message = panel.getByRole('article', { name: 'user message' }).last()
    await message.getByRole('button', { name: 'Preview example.ts' }).waitFor()
    await until(async () => !(await files.count()))
    t.check('sent message retains attachment chips', await message.isVisible())
    const accepted = await app.evaluate(() =>
      globalThis.__attachments.calls.filter((c) => c.type === 'send').at(-1)
    )
    t.equal('attachment-only message sends empty text', accepted.text, '')
    t.equal('ordinary file is sent as its original path', accepted.attachments[0].path, code)
    await input.press('ArrowUp')
    await files.getByRole('button', { name: 'Preview example.ts' }).waitFor()
    t.check('history recalls attachments', await files.isVisible())
    await input.press('ArrowDown')
    await until(async () => !(await files.count()))
    t.check('past newest history clears attachments', await send.isDisabled())
    await input.evaluate((el, png) => {
      const dataTransfer = new DataTransfer()
      dataTransfer.items.add(
        new File([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], 'Pasted screenshot.png', {
          type: 'image/png'
        })
      )
      el.dispatchEvent(
        new ClipboardEvent('paste', {
          clipboardData: dataTransfer,
          bubbles: true,
          cancelable: true
        })
      )
    }, PNG)
    await files.getByRole('button', { name: 'Preview Pasted screenshot.png' }).waitFor()
    t.check(
      'pasted screenshot gets a thumbnail',
      await until(async () => files.locator('img').count())
    )
    for (const theme of ['dark', 'light', 'coffee', 'charcoal']) {
      await win.evaluate((theme) => {
        document.documentElement.dataset.theme = theme
      }, theme)
      await win.waitForTimeout(250)
      const fits = await panel.evaluate((el) => {
        const box = el.getBoundingClientRect()
        return [...el.querySelectorAll('.conversation-attachment')].every((chip) => {
          const rect = chip.getBoundingClientRect()
          return rect.left >= box.left && rect.right <= box.right + 1
        })
      })
      t.check(`${theme} attachment chips stay inside the pane`, fits)
      if (process.env.CLAVE_CAPTURE_ATTACHMENTS && ['dark', 'light'].includes(theme))
        await panel.screenshot({ path: `/tmp/clave-attachments-${theme}.png` })
    }
    await send.click()
    await until(async () => !(await files.count()))
    const image = await app.evaluate(
      () => globalThis.__attachments.calls.filter((c) => c.type === 'send').at(-1).attachments[0]
    )
    t.equal('supported images use native delivery', image.delivery, 'image')
    t.check(
      'pasted bytes are saved under the isolated app profile',
      image.path.startsWith(userData) && existsSync(image.path)
    )
    await drop(panel, [svg])
    await files.getByRole('button', { name: 'Send as file reference' }).waitFor()
    t.check('unsupported formats block send until a choice is made', await send.isDisabled())
    await files.getByRole('button', { name: 'Send as file reference' }).click()
    t.check('explicit fallback enables send', await send.isEnabled())
    await files.getByRole('button', { name: 'Remove unsupported.svg' }).click()
    await drop(panel, [root])
    await panel.getByRole('alert').filter({ hasText: 'Folders' }).waitFor()
    t.check('folders show a preparation error and cannot be sent', await send.isDisabled())
    await panel.getByRole('button', { name: 'Remove project' }).click()
    // Native picker and backend preparation, with only the OS dialog stubbed.
    await app.evaluate(({ dialog }, code) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [code] })
    }, code)
    await panel.getByRole('button', { name: 'Add files', exact: true }).click()
    await files.getByRole('button', { name: 'Preview example.ts' }).waitFor()
    t.check('paperclip picker stages files', await files.isVisible())
    await files.getByRole('button', { name: 'Remove example.ts' }).click()
    await win.evaluate(() => {
      const input = document.createElement('input')
      input.type = 'file'
      input.multiple = true
      input.id = 'native-file-fixture'
      input.hidden = true
      document.body.append(input)
    })
    await win.locator('#native-file-fixture').setInputFiles([code, svg])
    await panel.evaluate((el) => {
      const input = document.querySelector('#native-file-fixture')
      const dataTransfer = new DataTransfer()
      for (const file of input.files) dataTransfer.items.add(file)
      el.dispatchEvent(new DragEvent('drop', { dataTransfer, bubbles: true, cancelable: true }))
      input.remove()
    })
    await files.getByRole('button', { name: 'Preview example.ts' }).waitFor()
    await files.getByRole('button', { name: 'Preview unsupported.svg' }).waitFor()
    t.equal(
      'native multi-file drop stages both files',
      await files.locator('.conversation-attachment-preview').count(),
      2
    )
    await callMcp(app, 'focus', { sessionId: OTHER })
    await other.waitFor()
    await drop(other, [image.path])
    await other.getByRole('button', { name: 'Send as file reference' }).waitFor()
    t.check(
      'text-only provider requires explicit image fallback',
      await other.getByRole('button', { name: 'Send', exact: true }).isDisabled()
    )
    await other.getByRole('button', { name: 'Send as file reference' }).click()
    await other.getByRole('button', { name: 'Send', exact: true }).click()
    const fallback = await app.evaluate(() =>
      globalThis.__attachments.calls.filter((c) => c.type === 'send').at(-1)
    )
    t.equal('fallback stays with the chosen session', fallback.sessionId, OTHER)
    t.equal('fallback delivery is recorded', fallback.attachments[0].delivery, 'reference')
    await callMcp(app, 'focus', { sessionId: ID })
    const extra = Array.from({ length: 8 }, (_, i) =>
      join(root, `long-file-name-for-small-pane-${i}.ts`)
    )
    for (const path of extra) writeFileSync(path, 'export const value = 1')
    await drop(panel, extra)
    t.check(
      'all ten files finish preparing',
      await until(
        async () => (await files.locator('.conversation-attachment-preview').count()) === 10
      )
    )
    const window = await app.browserWindow(win)
    await window.evaluate((window) => {
      window.setMinimumSize(400, 400)
      window.setSize(520, 480)
    })
    await win.waitForTimeout(250)
    const fits = await panel.evaluate((el) => {
      const panel = el.getBoundingClientRect()
      const input = el.querySelector('textarea').getBoundingClientRect()
      const send = el.querySelector('[aria-label="Send"]').getBoundingClientRect()
      const list = el.querySelector('.conversation-compose-files')
      return (
        input.top >= panel.top &&
        send.bottom <= panel.bottom &&
        list.scrollHeight > list.clientHeight
      )
    })
    t.check(
      'ten attachments scroll while message input and Send remain visible in a small pane',
      fits
    )
  } finally {
    if (app) await app.close()
    await stopOwnedService(userData, t)
    rmSync(directory, { recursive: true, force: true })
  }
}
