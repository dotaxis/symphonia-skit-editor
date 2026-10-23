import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openAuthored } from './fixtures';

type Document = {
  byteLength: number; codeOffset: number; dataOffset: number; codeEditable: boolean;
  messages: { index: number; text: string; tokens: object[] }[];
  instructions: { pc: number; nativeOpcode?: number; arguments: { value?: number }[] }[];
  entries: { pc: number }[];
};

const fixture = (name: string) => join(process.env.SKIT_TEST_FIXTURES!, name);
const fileInput = (page: Page) => page.locator('input[type="file"][accept=".skp,.json"]');
const rows = (page: Page) => page.locator('.line-row .line-content > span');

async function download(page: Page, button: string) {
  const awaited = page.waitForEvent('download');
  await page.getByRole('button', { name: button }).click();
  const item = await awaited;
  const path = await item.path();
  expect(path).not.toBeNull();
  return { name: item.suggestedFilename(), bytes: await readFile(path!) };
}

async function core<T>(page: Page, operation: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(async ({ operation, args }) => {
    const api = await import('/src/core.ts');
    if (['parse_skit', 'compile_skit'].includes(operation)) args[0] = new Uint8Array(args[0] as number[]);
    const result = await api.core(operation, ...args);
    return result instanceof Uint8Array ? [...result] : result;
  }, { operation, args });
}

async function openSynthetic(page: Page) {
  await page.goto('/');
  await fileInput(page).setInputFiles(fixture('FC_W001.SKP'));
  await expect(page.getByRole('status')).toContainText('Opened FC_W001.SKP');
  await expect(rows(page)).toHaveCount(2);
}

test('startup stays local, and malformed files fail without replacing an open document', async ({ page }) => {
  const crashes: string[] = [];
  const remote: string[] = [];
  page.on('pageerror', error => crashes.push(error.message));
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.protocol.startsWith('http') && url.hostname !== '127.0.0.1') remote.push(request.url());
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('No skit open');
  await expect(page.locator('.tool-title')).toContainText('TOS Skit Editor');
  await expect(page.getByRole('button', { name: /Create a custom skit|^New$/ })).toHaveCount(0);
  await expect(page.locator('.welcome-features')).toHaveCount(0);
  await fileInput(page).setInputFiles({ name: 'broken.SKP', mimeType: 'application/octet-stream', buffer: Buffer.from([2, 0, 0]) });
  await expect(page.getByRole('alert')).toContainText('shorter than');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await fileInput(page).setInputFiles(fixture('FC_W001.SKP'));
  await expect(rows(page)).toHaveCount(2);
  await fileInput(page).setInputFiles({ name: 'broken.skit.json', mimeType: 'application/json', buffer: Buffer.from('{"format":"wrong","version":1}') });
  await expect(page.getByRole('alert')).toContainText('not a supported');
  await expect(rows(page)).toHaveText(['Hello, synthetic skit.', 'Speak to ⟦Character name⟧.']);
  expect(crashes).toEqual([]);
  expect(remote).toEqual([]);
});

test('included portraits and facial frames work immediately with an opened skit', async ({ page }) => {
  await page.goto('/');
  const bytes = await core<number[]>(page, 'author_skit', JSON.stringify({
    actors: [{ id: 1, textureSlot: 0, x: 320, y: 200 }],
    rows: [{ text: 'A synthetic skit with a loaded portrait.', speaker: 1, durationTicks: 180 }],
  }));
  await fileInput(page).setInputFiles({ name: 'FC_W001.SKP', mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) });
  await expect(rows(page)).toHaveCount(1);
  await expect(page.getByLabel('Eye animation')).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Create a custom skit', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Cast & staging', exact: true }).click();
  await page.getByRole('button', { name: 'Browse portraits', exact: true }).click();
  const gallery = page.getByRole('dialog', { name: 'Choose a portrait' });
  await expect(gallery).toBeVisible();
  await expect(gallery.locator('.portrait-choice')).toHaveCount(24);
  await expect(gallery.locator('.portrait-thumbnail canvas')).toHaveCount(24);
  await expect(gallery.locator('.portrait-error')).toHaveCount(0);
  await expect(gallery.locator('.portrait-placeholder')).toHaveCount(0);
  const firstPainted = await gallery.locator('canvas').first().evaluate((canvas: HTMLCanvasElement) => {
    const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    return pixels.some((value, index) => index % 4 === 3 && value > 0);
  });
  expect(firstPainted).toBe(true);
  await gallery.getByRole('button', { name: /^Select portrait 1,/ }).click();
  await expect(gallery).toHaveCount(0);
  const exported = await download(page, 'Export SKP');
  const changed = await core<Document>(page, 'parse_skit', [...exported.bytes]);
  const resourceLoad = changed.instructions.find(instruction => instruction.nativeOpcode === 0x58)!;
  const spawn = changed.instructions.find(instruction => instruction.nativeOpcode === 0x57)!;
  expect(resourceLoad.arguments[0].value).toBe(0xd0001);
  expect(spawn.arguments[12].value).toBe(0xd0001);
  expect(changed.messages[0].text).toBe('A synthetic skit with a loaded portrait.');
  await page.getByRole('button', { name: 'Voices', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Load voice clips' })).toBeVisible();
  await expect(page.locator('input[type="file"][accept=".awb"]')).toHaveCount(1);
});

test('sequence editing starts from an open skit and saves its original project before conversion', async ({ page }) => {
  await openSynthetic(page);
  await page.getByRole('button', { name: 'Script details', exact: true }).click();
  await page.getByText('Sequence editing', { exact: true }).click();
  await page.getByRole('button', { name: 'Edit as sequence', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(/parallel|choreography/i);
  const backup = await download(page, 'Save original & edit sequence');
  const originalProject = JSON.parse(backup.bytes.toString());
  expect(originalProject.kind).toBe('retail');
  expect(Buffer.from(originalProject.original, 'base64')).toEqual(await readFile(fixture('FC_W001.SKP')));
  await page.getByRole('button', { name: 'Dialogue', exact: true }).click();
  await expect(rows(page).first()).toHaveText('Hello, synthetic skit.');
  await expect(rows(page)).toHaveCount(2);
  await expect(page.getByRole('button', { name: '+ Add line', exact: true })).toBeVisible();
  await expect(page.getByLabel('Duration (60 Hz ticks)')).toHaveValue('180');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Edited text 1', exact: true })).toHaveValue('Hello, synthetic skit.');
  await expect(rows(page).nth(1)).toHaveText('Speak to ⟦Character name⟧.');
});

test('native fixture and WASM agree on parsing, exact export, and growing edits', async ({ page }) => {
  await page.goto('/');
  const original = await readFile(fixture('FC_W001.SKP'));
  const native = JSON.parse(await readFile(fixture('original.json'), 'utf8'));
  const parsed = await core<Document>(page, 'parse_skit', [...original]);
  expect(parsed).toEqual(native);
  const unchanged = await core<number[]>(page, 'compile_skit', [...original], '{}');
  expect(Buffer.from(unchanged)).toEqual(original);
  const edits = await readFile(fixture('edits.json'), 'utf8');
  const changed = await core<number[]>(page, 'compile_skit', [...original], edits);
  expect(Buffer.from(changed)).toEqual(await readFile(fixture('expected.SKP')));
  expect(await core(page, 'parse_skit', changed)).toEqual(JSON.parse(await readFile(fixture('expected.json'), 'utf8')));
});

test('imported text, speaker and timing edits export exactly and preserve the other line', async ({ page }) => {
  await openSynthetic(page);
  const { grownText } = JSON.parse(await readFile(fixture('meta.json'), 'utf8'));
  await page.getByRole('textbox', { name: 'Edited text 1', exact: true }).fill(grownText);
  await page.getByLabel('Speaking character').selectOption('2');
  await page.getByLabel('Voice milestone (original value)').fill('300');
  await expect(page.locator('.original-text')).toContainText('Hello, synthetic skit.');
  await expect(rows(page).nth(1)).toHaveText('Speak to ⟦Character name⟧.');
  const saved = await download(page, 'Save project');
  const project = JSON.parse(saved.bytes.toString());
  const original = await readFile(fixture('FC_W001.SKP'));
  expect(project.kind).toBe('retail');
  expect(Buffer.from(project.original, 'base64')).toEqual(original);
  await fileInput(page).setInputFiles(fixture('FC_W001.SKP'));
  await fileInput(page).setInputFiles({ name: saved.name, mimeType: 'application/json', buffer: saved.bytes });
  await expect(page.getByRole('status')).toContainText('Project opened');
  await expect(page.getByRole('textbox', { name: 'Edited text 1', exact: true })).toHaveValue(grownText);
  await expect(page.locator('.original-text')).toContainText('Hello, synthetic skit.');
  const exported = await download(page, 'Export SKP');
  expect(exported.name).toBe('FC_W001.SKP');
  expect(exported.bytes).toEqual(await readFile(fixture('expected.SKP')));
  expect(exported.bytes.length).toBeGreaterThan(original.length);
  expect(exported.bytes.subarray(-64)).toEqual(original.subarray(-64));
  await fileInput(page).setInputFiles({ name: exported.name, mimeType: 'application/octet-stream', buffer: exported.bytes });
  await expect(page.getByRole('textbox', { name: 'Edited text 1', exact: true })).toHaveValue(grownText);
  await expect(page.getByLabel('Speaking character')).toHaveValue('2');
  await expect(page.getByLabel('Voice milestone (original value)')).toHaveValue('300');
  await page.locator('.line-row').nth(1).click();
  await expect(page.locator('.control-token')).toContainText('Character name · protected');
  expect(await core(page, 'parse_skit', [...exported.bytes])).toEqual(JSON.parse(await readFile(fixture('expected.json'), 'utf8')));
});

test('sequence lines insert, reorder, delete, undo, redo, and survive project reopen', async ({ page }) => {
  await page.goto('/');
  await openAuthored(page);
  await page.getByRole('textbox', { name: 'Edited text', exact: true }).fill('Alpha line.');
  await page.getByRole('button', { name: '+ Add line', exact: true }).click();
  await page.getByRole('textbox', { name: 'Edited text', exact: true }).fill('Beta line.');
  await page.getByRole('button', { name: '+ Add line', exact: true }).click();
  await page.getByRole('textbox', { name: 'Edited text', exact: true }).fill('Gamma line.');
  await expect(rows(page)).toHaveText(['Alpha line.', 'Beta line.', 'Gamma line.']);
  await page.getByRole('button', { name: 'Move line up', exact: true }).click();
  await expect(rows(page)).toHaveText(['Alpha line.', 'Gamma line.', 'Beta line.']);
  await page.getByRole('button', { name: 'Duplicate', exact: true }).click();
  await expect(rows(page)).toHaveText(['Alpha line.', 'Gamma line.', 'Gamma line.', 'Beta line.']);
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(rows(page)).toHaveText(['Alpha line.', 'Gamma line.', 'Beta line.']);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(rows(page)).toHaveCount(4);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(rows(page)).toHaveText(['Alpha line.', 'Gamma line.', 'Beta line.']);
  const saved = await download(page, 'Save project');
  const project = JSON.parse(saved.bytes.toString());
  expect(project.format).toBe('tos-skit-project');
  expect(project.project.rows.map((row: { text: string }) => row.text)).toEqual(['Alpha line.', 'Gamma line.', 'Beta line.']);
  await fileInput(page).setInputFiles(fixture('FC_W001.SKP'));
  await expect(rows(page)).toHaveCount(2);
  await fileInput(page).setInputFiles({ name: saved.name, mimeType: 'application/json', buffer: saved.bytes });
  await expect(page.getByRole('status')).toContainText('Sequence project opened');
  await expect(rows(page)).toHaveText(['Alpha line.', 'Gamma line.', 'Beta line.']);
});

test('muted sequence export has text, staging and duration without a voice playback or voice wait', async ({ page }, testInfo) => {
  await page.goto('/');
  await openAuthored(page);
  await page.getByRole('textbox', { name: 'Edited text', exact: true }).fill('A brand-new synthetic conversation.');
  await page.getByLabel('Duration (60 Hz ticks)').fill('360');
  await page.getByLabel('Voice ID (packed bank + entry)').fill('65537');
  await page.getByLabel('Enabled in game').check();
  await page.getByLabel('Enabled in game').uncheck();
  await page.getByRole('button', { name: 'Cast & staging', exact: true }).click();
  await page.getByLabel('X position', { exact: true }).fill('240');
  await page.getByLabel('Y position', { exact: true }).fill('180');
  await page.getByRole('button', { name: 'Dialogue', exact: true }).click();
  const exported = await download(page, 'Export SKP');
  const document = await core<Document>(page, 'parse_skit', [...exported.bytes]);
  expect(document.codeEditable).toBe(true);
  expect(document.messages[0].text).toBe('A brand-new synthetic conversation.');
  const calls = document.instructions.filter(instruction => instruction.nativeOpcode !== undefined);
  const spawn = calls.find(instruction => instruction.nativeOpcode === 0x57)!;
  expect(spawn.arguments[2].value).toBe(240);
  expect(spawn.arguments[3].value).toBe(180);
  expect(calls.filter(instruction => instruction.nativeOpcode === 0x56).every(instruction => instruction.arguments[0].value === -1)).toBe(true);
  expect(calls.filter(instruction => instruction.nativeOpcode === 0x59)).toEqual([]);
  expect(calls.some(instruction => instruction.nativeOpcode === 0x64 && instruction.arguments[0].value === 0 && instruction.arguments[1].value === 360)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('sequence-workspace.png'), fullPage: true });
});

test('unsupported text and slot names block export with a useful validation message', async ({ page }) => {
  await page.goto('/');
  await openAuthored(page);
  await page.getByRole('textbox', { name: 'Edited text', exact: true }).fill('Unsupported café');
  await expect(page.getByRole('alert')).toContainText('ASCII');
  await expect(page.getByRole('button', { name: 'Export SKP' })).toBeDisabled();
  await page.getByRole('textbox', { name: 'Edited text', exact: true }).fill('Supported English.');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: 'Script details', exact: true }).click();
  await page.getByLabel('Existing skit slot filename').fill('UNREGISTERED.SKP');
  await page.getByRole('button', { name: 'Export SKP' }).click();
  await expect(page.getByRole('alert')).toContainText('existing slot filename');
});
