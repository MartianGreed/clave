import { afterEach, expect, test } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareAttachment, preparePrompt } from './attachments'
const directories: string[] = []
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGUlEQVR4nGPwrn32nxLMMGrAqAGjBgwXAwB7Aq0fO8+5wwAAAABJRU5ErkJggg==',
  'base64'
)
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
async function setup(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'clave-attachments-'))
  directories.push(dir)
  return dir
}

test('copies a pasted image durably and encodes actual bytes for the provider', async () => {
  const directory = await setup()
  const file = await prepareAttachment(directory, { name: 'Screenshot.png', bytes: png })
  expect(await readFile(file.path)).toEqual(png)
  const prompt = await preparePrompt('', [file], true)
  expect(prompt.images).toEqual([
    { name: file.name, mimeType: 'image/png', data: png.toString('base64') }
  ])
  await expect(preparePrompt('', [file], false)).rejects.toThrow('Send as file reference')
  expect((await preparePrompt('', [{ ...file, delivery: 'reference' }], false)).text).toContain(
    file.path
  )
})
test('rejects missing files, directories and image bytes disguised by their name', async () => {
  const directory = await setup()
  await expect(prepareAttachment(directory, { path: directory })).rejects.toThrow('Folders')
  await expect(
    prepareAttachment(directory, { name: 'bad.png', bytes: Buffer.from('not an image') })
  ).rejects.toThrow('Only PNG')
  const path = join(directory, 'fake.png')
  await writeFile(path, 'not an image')
  const file = await prepareAttachment(join(directory, 'saved'), { path })
  await expect(preparePrompt('', [file], true)).rejects.toThrow('do not match')
  await rm(file.path)
  await expect(preparePrompt('', [file], true)).rejects.toThrow('unavailable')
})
test('copies temporary drops so deleting their source does not break the attachment', async () => {
  const directory = await setup()
  const path = join(directory, 'Screenshot.png')
  await writeFile(path, png)
  const file = await prepareAttachment(join(directory, 'saved'), { path })
  expect(file.path).not.toBe(path)
  await rm(path)
  expect((await preparePrompt('inspect', [file], true)).images).toHaveLength(1)
})
test('rejects too many files, excessive image bytes and invalid paths', async () => {
  const directory = await setup()
  const file = await prepareAttachment(directory, { name: 'image.png', bytes: png })
  await expect(preparePrompt('', Array(11).fill(file), true)).rejects.toThrow()
  await expect(preparePrompt('', [{ ...file, path: 'relative' }], true)).rejects.toThrow('absolute')
  await writeFile(file.path, Buffer.alloc(5 * 1024 * 1024 + 1))
  await expect(preparePrompt('', [file], true)).rejects.toThrow('5 MiB')
})
test('ordinary references keep the original file path and do not embed contents', async () => {
  // An in-repository directory is stable; OS temporary directories are deliberately copied.
  const directory = await mkdtemp(join(process.cwd(), '.attachments-unit-'))
  directories.push(directory)
  const path = join(directory, 'index.ts')
  await writeFile(path, 'original')
  await mkdir(join(directory, 'saved'))
  const file = await prepareAttachment(join(directory, 'saved'), { path })
  expect(file.path).toBe(path)
  await writeFile(path, 'updated')
  const prompt = await preparePrompt('read this', [file], false)
  expect(prompt.text).toContain(JSON.stringify(path))
  expect(prompt.text).not.toContain('original')
  expect(prompt.text).not.toContain('updated')
  expect(prompt.images).toEqual([])
})
