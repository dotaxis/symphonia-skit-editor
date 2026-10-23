import { test, expect, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { openAuthored } from './fixtures';

const input = (page: Page) => page.locator('input[type="file"][accept=".skp,.json"]');
const actor = { id: 1, name: 'Synthetic actor', textureSlot: 0, x: 320, y: 200, scalePercent: 100, rotation: 0, alpha: 255 };
const row = (id: string, text: string, eyeFrame = -1) => ({
  id, text, speaker: 1, voiceId: null, voiceEnabled: false,
  durationTicks: 60, eyeFrame, mouthFrame: -1, stage: [],
});
async function openProject(page: Page, rows: ReturnType<typeof row>[]) {
  await page.goto('/');
  await input(page).setInputFiles({ name: 'synthetic.skit.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
    format: 'tos-skit-project', version: 1, kind: 'authored',
    project: { filename: 'FC_W001.SKP', actors: [actor], rows },
  })) });
  await expect(page.getByRole('status')).toContainText('Sequence project opened');
}

test('built static site loads its worker and WASM under a GitHub Pages repository subpath', async ({ page }) => {
  const root = resolve('dist');
  const prefix = '/test-repository/';
  const missing: string[] = [];
  const contentTypes: Record<string, string> = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png',
  };
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url!, 'http://localhost').pathname;
    if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    if (!pathname.startsWith(prefix)) {
      missing.push(pathname); response.writeHead(404); response.end(); return;
    }
    const suffix = decodeURIComponent(pathname.slice(prefix.length)) || 'index.html';
    const path = resolve(root, suffix);
    if (!path.startsWith(root + sep)) { response.writeHead(403); response.end(); return; }
    try {
      const bytes = await readFile(path);
      response.writeHead(200, { 'Content-Type': contentTypes[extname(path)] || 'application/octet-stream' });
      response.end(bytes);
    } catch {
      missing.push(pathname); response.writeHead(404); response.end();
    }
  });
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Static test server did not bind a TCP port');
  const errors: string[] = [];
  const wasmResponses: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('requestfailed', request => errors.push(`${request.url()}: ${request.failure()?.errorText}`));
  page.on('response', response => { if (response.url().endsWith('.wasm') && response.status() === 200) wasmResponses.push(response.url()); });
  try {
    await page.goto(`http://127.0.0.1:${address.port}${prefix}`);
    await expect(page.getByText('Included, with facial animation data.', { exact: true })).toBeVisible();
    await openAuthored(page);
    await expect(page.getByLabel('Eye animation')).toBeEnabled();
    await page.getByRole('button', { name: 'Choose portrait expression', exact: true }).click();
    const gallery = page.getByRole('dialog', { name: 'Choose a portrait' });
    await expect(gallery.locator('.portrait-thumbnail canvas')).toHaveCount(24);
    await expect(gallery.locator('.portrait-error')).toHaveCount(0);
    await page.getByRole('button', { name: 'Close portrait gallery' }).click();
    await page.getByRole('textbox', { name: 'Edited text', exact: true }).fill('Exported from a static repository subpath.');
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export SKP' }).click();
    const download = await pending;
    expect(download.suggestedFilename()).toBe('FC_W001.SKP');
    const bytes = await readFile((await download.path())!);
    expect(bytes.readUInt32LE(0)).toBe(2);
    expect(bytes.readUInt32LE(4)).toBe(64);
    expect(bytes.readUInt32LE(8) + 64).toBe(bytes.length);
    expect(bytes.includes(Buffer.from('Exported from a static repository subpath.'))).toBe(true);
    expect(wasmResponses.length).toBeGreaterThan(0);
    expect(wasmResponses.every(url => url.includes(prefix))).toBe(true);
    expect(missing).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await new Promise<void>(done => server.close(() => done()));
  }
});

test('saved facial frame overrides validate against the bundled catalog without an executable import', async ({ page }) => {
  await openProject(page, [row('forced', 'Saved text with a forced eye frame.', 0)]);
  await expect(page.getByRole('textbox', { name: 'Edited text', exact: true })).toHaveValue('Saved text with a forced eye frame.');
  await expect(page.getByRole('button', { name: 'Export SKP' })).toBeEnabled();
  await expect(page.getByLabel('Eye animation')).toBeEnabled();
  await expect(page.getByLabel('Eye animation')).toHaveValue('0');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  const download = await pending;
  const saved = JSON.parse((await readFile((await download.path())!)).toString());
  expect(saved.project.rows[0].eyeFrame).toBe(0);
});

test('out-of-range facial frames remain recoverable in a project but block SKP export', async ({ page }) => {
  await openProject(page, [row('invalid-frame', 'Repair this saved frame.', 255)]);
  await expect(page.getByRole('alert')).toContainText(/frame/i);
  await expect(page.getByRole('button', { name: 'Export SKP' })).toBeDisabled();
  await page.getByLabel('Eye animation').selectOption('-1');
  await expect(page.getByRole('button', { name: 'Export SKP' })).toBeEnabled();
});

test('whole-skit preview progresses through rows and stops at the final duration', async ({ page }) => {
  await openProject(page, [row('first', 'First timed line.'), row('second', 'Second timed line.')]);
  await page.locator('.line-row').nth(1).click();
  await page.getByRole('button', { name: 'Play whole skit' }).click();
  await expect(page.locator('.line-row.selected .line-content > span')).toHaveText('First timed line.');
  await expect(page.getByRole('button', { name: 'Pause preview' })).toBeVisible();
  await expect(page.locator('.line-row.selected .line-content > span')).toHaveText('Second timed line.', { timeout: 4000 });
  await expect(page.getByRole('button', { name: 'Play preview', exact: true })).toBeVisible({ timeout: 4000 });
  await expect(page.getByRole('slider', { name: 'Preview playhead' })).toHaveValue('1');
});

test('ordinary 0x0C dialogue text edits preserve its separate name record and native call', async ({ page }) => {
  await page.goto('/');
  const bytes = await page.evaluate(async () => {
    const { core } = await import('/src/core.ts');
    const instructions: object[] = [];
    for (const value of [0, 64, -1, 1, 0, 0, 0, 1]) instructions.push({ kind: 'literal', value }, { kind: 'calculate', opcode: 0 }, { kind: 'argument' });
    instructions.push({ kind: 'native', opcode: 0x0c }, { kind: 'end' });
    return [...await core('create_skit', JSON.stringify({ instructions, messages: [
      [{ kind: 'text', text: 'Synthetic name' }], [{ kind: 'text', text: 'Independent dialogue body.' }],
    ] })) as Uint8Array];
  });
  await input(page).setInputFiles({ name: 'FC_W001.SKP', mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) });
  await expect(page.locator('.line-row')).toHaveCount(1);
  await expect(page.locator('.line-row .line-content > span')).toHaveText('Independent dialogue body.');
  await expect(page.getByLabel('Speaking character')).toBeDisabled();
  const editedText = 'An expanded ordinary dialogue body, preserving the independent title record.';
  await page.getByRole('textbox', { name: 'Edited text 1', exact: true }).fill(editedText);
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export SKP' }).click();
  const downloaded = await pending;
  const output = await readFile((await downloaded.path())!);
  const result = await page.evaluate(async ({ bytes }) => {
    const { core } = await import('/src/core.ts');
    return core('parse_skit', new Uint8Array(bytes));
  }, { bytes: [...output] }) as { codeOffset: number; dataOffset: number; messages: { text: string }[] };
  expect(result.messages.map(message => message.text)).toEqual(['Synthetic name', editedText]);
  expect(output.subarray(result.codeOffset, result.dataOffset)).toEqual(Buffer.from(bytes).subarray(result.codeOffset, result.dataOffset));
});
