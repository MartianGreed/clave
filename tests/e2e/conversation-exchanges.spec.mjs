import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
  cpSync
} from 'node:fs'
import { join } from 'node:path'
import {
  REPO,
  launchApp,
  seedWorkspaces,
  callMcp,
  until,
  stubFolderDialog,
  openWindow,
  identityOf,
  mcpEndpoint,
  mcpHttpClient,
  toolPayload,
  toolErrored
} from './harness.mjs'

let ID
let OTHER
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
    'test-owned communication service stops',
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
  const directory = mkdtempSync(join(REPO, '.conversation-exchanges-'))
  const root = join(directory, 'project')
  const userData = join(directory, 'app')
  mkdirSync(root)
  seedWorkspaces(userData, {
    workspaces: [{ id: 'communications', name: 'Communications', rootDir: root, createdAt: 1 }],
    activeWorkspaceId: 'communications',
    fresh: true
  })
  let app
  try {
    const launched = await launchApp(userData)
    app = launched.app
    const win = launched.win
    win.setDefaultTimeout(6000)
    const plugin = join(root, 'plugin')
    cpSync(join(REPO, 'examples/runtime-plugins/echo-report'), plugin, { recursive: true })
    await stubFolderDialog(app, { returns: plugin })
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: true })
    })
    await win.evaluate(() => window.electronAPI.runtimePlugins.install())
    const ids = await win.evaluate(async (cwd) => {
      const lane = await window.electronAPI.conversations.create({
        provider: 'example.echo',
        cwd,
        title: 'Lane'
      })
      const wave = await window.electronAPI.conversations.create({
        provider: 'example.echo',
        cwd,
        title: 'Wave'
      })
      return [lane.session.id, wave.session.id]
    }, root)
    ;[ID, OTHER] = ids
    await win.reload()
    await win.waitForLoadState('domcontentloaded')
    await win.locator('[data-testid="conversation-panel"]').first().waitFor()
    await callMcp(app, 'focus', { sessionId: ID })
    const panel = win.locator(`[data-conversation-id="${ID}"]`)
    await panel.waitFor()
    const input = panel.getByRole('textbox', { name: 'Message', exact: true })

    const group = await callMcp(app, 'createGroup', { name: 'Exos workstream' })
    for (const sessionId of [ID, OTHER])
      await callMcp(app, 'moveSession', { sessionId, groupId: group.groupId })
    await input.fill('My draft stays here')
    await callMcp(app, 'sendToSession', {
      sessionId: ID,
      callerSessionId: OTHER,
      message: 'QUESTION: Which migration is ready?'
    })
    const incoming = panel.getByRole('article', { name: 'Agent message' })
    await incoming.getByText('QUESTION: Which migration is ready?', { exact: true }).waitFor()
    t.equal(
      'cross-tab delivery is visibly distinct from a human message',
      await incoming.count(),
      1
    )
    t.equal(
      'incoming delivery preserves the composer draft',
      await input.inputValue(),
      'My draft stays here'
    )
    t.check(
      'source session is a direct link',
      await incoming.getByRole('button', { name: 'Wave', exact: true }).isVisible()
    )
    await input.fill('')
    await input.press('ArrowUp')
    t.equal('agent deliveries do not enter human message recall', await input.inputValue(), '')
    await incoming.getByRole('button', { name: 'Wave', exact: true }).click()
    await win.locator(`[data-conversation-id="${OTHER}"]`).waitFor({ state: 'visible' })
    t.check('source link opens the source session', true)
    await callMcp(app, 'sendToSession', {
      sessionId: OTHER,
      callerSessionId: ID,
      message: 'ANSWER: The session migration is ready.'
    })
    await callMcp(app, 'sendToSession', {
      sessionId: 'mine',
      callerSessionId: ID,
      message: 'CHECKPOINT: GATES GREEN'
    })
    await callMcp(app, 'focus', { sessionId: ID })
    await panel.getByRole('button', { name: 'Communication history', exact: true }).click()
    const history = win.getByRole('dialog', { name: 'Communication history' })
    await history.getByText('CHECKPOINT: GATES GREEN', { exact: true }).waitFor()
    t.check(
      'persisted history includes inbound question and outbound answer',
      (await history
        .getByText('QUESTION: Which migration is ready?', { exact: true })
        .isVisible()) &&
        (await history
          .getByText('ANSWER: The session migration is ready.', { exact: true })
          .isVisible())
    )
    t.check(
      'self checkpoint is labeled logged only',
      (await history.textContent()).includes('Logged only')
    )
    t.equal(
      'self checkpoint was never submitted to provider',
      await win.evaluate(
        async (id) =>
          (await window.electronAPI.conversations.snapshot(id)).entries.filter(
            (e) => e.kind === 'message' && e.text.includes('GATES GREEN')
          ).length,
        ID
      ),
      0
    )
    await history.getByRole('button', { name: 'Exos workstream', exact: true }).click()
    await history.getByText('ANSWER: The session migration is ready.', { exact: true }).waitFor()
    t.check('workstream scope includes both sides of communication', true)
    await history.getByRole('button', { name: 'Wave', exact: true }).first().click()
    await win.locator(`[data-conversation-id="${OTHER}"]`).waitFor({ state: 'visible' })
    await history.waitFor({ state: 'hidden' })
    t.check('history session link opens its target and dismisses the history panel', true)

    await win.keyboard.press('Escape')
    await win.reload()
    await win.waitForLoadState('domcontentloaded')
    await panel.waitFor({ state: 'attached' })
    await callMcp(app, 'focus', { sessionId: ID })
    await panel.getByRole('button', { name: 'Communication history', exact: true }).click()
    await history.getByText('CHECKPOINT: GATES GREEN', { exact: true }).waitFor()
    t.check('history survives renderer reload', true)
    const stored = JSON.parse(
      readFileSync(join(userData, 'exchange-capture/events.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .find((line) => JSON.parse(line).text === 'QUESTION: Which migration is ready?')
    )
    t.equal('conversation send writes the existing Exos transport contract', stored.v, 2)
    t.equal('transport records the correct source', stored.sender.sessionId, OTHER)
    t.equal('transport records the workstream at send time', stored.sender.groupId, group.groupId)
    if (process.env.CLAVE_CAPTURE_EXCHANGES) {
      await win.waitForTimeout(300)
      await win.screenshot({ path: '/tmp/clave-exos-history.png' })
    }
    await win.keyboard.press('Escape')
    await stubFolderDialog(app, {
      returns: join(REPO, 'examples/runtime-plugins/exos-communications')
    })
    await win.evaluate(() => window.electronAPI.runtimePlugins.install())
    const report = panel.locator('[data-artifact-id]').first()
    await report.getByRole('button', { name: 'Wave / Lane communications', exact: true }).click()
    const exos = report.frameLocator('iframe')
    await exos.getByText('QUESTION: Which migration is ready?', { exact: true }).waitFor()
    await exos.getByText('ANSWER: The session migration is ready.', { exact: true }).waitFor()
    t.check(
      'installable Exos plugin renders persisted Wave/Lane Q&A through the sandbox bridge',
      true
    )
    await exos.getByRole('button', { name: 'Wave', exact: true }).first().click()
    await win.locator(`[data-conversation-id="${OTHER}"]`).waitFor({ state: 'visible' })
    t.check('Exos plugin source link opens a related session', true)
    await callMcp(app, 'focus', { sessionId: ID })
    await report.getByRole('button', { name: 'View original', exact: true }).click()
    // Attached group views expose communication history alongside the workstream page.
    const dashboard = join(root, 'workstream.html')
    writeFileSync(dashboard, '<!doctype html><title>Workstream fixture</title><h1>Workstream</h1>')
    await callMcp(app, 'setGroupView', {
      groupId: group.groupId,
      url: dashboard,
      title: 'Exos workstream'
    })
    await win
      .locator(`[data-sidebar-item-type="group"][data-sidebar-item-id="${group.groupId}"]`)
      .click()
    await win.locator('button[aria-label="Communication history"]:visible').click()
    await history.getByText('CHECKPOINT: GATES GREEN', { exact: true }).waitFor()
    t.check('attached workstream view exposes the group communication history', true)
    await win.keyboard.press('Escape')
    await callMcp(app, 'focus', { sessionId: ID })
    // Missing source must retain readable content and explain why navigation failed.
    await win.evaluate(
      (id) =>
        window.electronAPI.conversations.send(
          id,
          '[Message from Clave tab "Closed lane" — reply with clave_send_to_session sessionId="closed-session"]\nHistorical question',
          'closed-source'
        ),
      ID
    )
    await panel.getByRole('button', { name: 'Closed lane', exact: true }).click()
    await panel.getByText('Session no longer open', { exact: true }).waitFor()
    t.check(
      'closed source has a readable message and explicit navigation state',
      await panel
        .getByRole('article', { name: 'Agent message' })
        .getByText('Historical question', { exact: true })
        .isVisible()
    )
    const before = await win.evaluate(
      async (id) =>
        (await window.electronAPI.conversations.snapshot(id)).entries.filter(
          (e) => e.kind === 'message' && e.role === 'user'
        ).length,
      ID
    )
    const unrelated = await callMcp(app, 'createGroup', { name: 'Unrelated project' })
    await callMcp(app, 'moveSession', { sessionId: OTHER, groupId: unrelated.groupId })
    let denied = false
    try {
      await callMcp(app, 'sendToSession', {
        sessionId: ID,
        callerSessionId: OTHER,
        message: 'Must be refused'
      })
    } catch {
      denied = true
    }
    t.check('unrelated sessions remain unable to send', denied)
    t.equal(
      'refused delivery does not reach provider',
      await win.evaluate(
        async (id) =>
          (await window.electronAPI.conversations.snapshot(id)).entries.filter(
            (e) => e.kind === 'message' && e.role === 'user'
          ).length,
        ID
      ),
      before
    )
    const storedPage = await win.evaluate(
      (id) => window.electronAPI.exchangeHistory({ sessionId: id }),
      ID
    )
    t.check(
      'refused delivery is absent from communication history',
      !storedPage.messages.some((m) => m.text === 'Must be refused')
    )
    // Real HTTP routing must preserve provenance when the sender lives in another window.
    await win.evaluate(
      async ({ node, fixture }) => {
        await window.electronAPI.launchProfileUpsert({
          id: 'fixture-exos',
          name: 'Fixture Exos',
          family: 'claude',
          command: [node, fixture],
          additionalArgs: []
        })
        await window.electronAPI.launchProfileSetGlobal('claude', 'fixture-exos')
      },
      { node: process.execPath, fixture: join(REPO, 'tests/e2e/fixtures/conversation-claude.mjs') }
    )
    const source = await callMcp(app, 'openSession', {
      cwd: root,
      mode: 'claude',
      name: 'Window A wave'
    })
    await win.evaluate(
      (id) => window.electronAPI.conversations.send(id, 'Start local fixture', 'start-source'),
      source.sessionId
    )
    const auth = JSON.parse(
      readFileSync(join(userData, 'mcp-configs', source.sessionId + '.json'), 'utf8')
    ).mcpServers.clave.headers.Authorization
    const client = mcpHttpClient(mcpEndpoint(userData), auth.replace(/^Bearer /, ''))
    await client.init()
    const second = await openWindow(app, win, 'communications', { settleMs: 500 })
    const secondId = await identityOf(second.page)
    const opened = await client.call('clave_open_session', {
      cwd: root,
      mode: 'claude',
      name: 'Window B lane',
      window: secondId.windowId
    })
    t.check('wave opens a related lane in a second window', !toolErrored(opened))
    const child = toolPayload(opened)
    if (!child?.sessionId) throw new Error('Cross-window child was not created')
    const delivery = await client.call('clave_send_to_session', {
      sessionId: child.sessionId,
      message: 'Cross-window assignment'
    })
    t.check(
      'authenticated HTTP send reaches the second-window lane',
      !toolErrored(delivery) && toolPayload(delivery)?.delivered === true
    )
    const secondPanel = second.page.locator(`[data-conversation-id="${child.sessionId}"]`)
    await secondPanel
      .getByRole('article', { name: 'Agent message' })
      .getByText('Cross-window assignment', { exact: true })
      .waitFor()
    await secondPanel.getByRole('button', { name: 'Window A wave', exact: true }).click()
    await win.locator(`[data-conversation-id="${source.sessionId}"]`).waitFor({ state: 'visible' })
    t.check('source link navigates to its owning window', true)
    const cross = await win.evaluate(
      async (id) => window.electronAPI.exchangeHistory({ sessionId: id }),
      source.sessionId
    )
    t.equal(
      'cross-window capture retains the authenticated source ID',
      cross.messages.find((m) => m.text === 'Cross-window assignment')?.sender.sessionId,
      source.sessionId
    )
  } finally {
    await app?.close()
    await stopOwnedService(userData, t)
    rmSync(directory, { recursive: true, force: true })
  }
}
