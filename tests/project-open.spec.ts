import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { authoredProject, openAuthored } from './fixtures';

const fileInput = (page: Page) => page.locator('input[type="file"][accept=".skp,.json"]');
const authoredText = (page: Page) => page.getByRole('textbox', { name: 'Edited text', exact: true });
const retailText = (page: Page) => page.getByRole('textbox', { name: 'Edited text 1', exact: true });
const fixture = (name: string) => join(process.env.SKIT_TEST_FIXTURES!, name);

async function openJson(page: Page, value: unknown, name = 'draft.skit.json') {
  await fileInput(page).setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)) });
}

async function saveProject(page: Page) {
  const awaited = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  const download = await awaited;
  const path = await download.path();
  expect(path).not.toBeNull();
  return { name: download.suggestedFilename(), bytes: await readFile(path!) };
}

async function startDraft(page: Page, text = 'Keep this unsaved draft.') {
  await page.goto('/');
  await openAuthored(page);
  await authoredText(page).fill(text);
  await expect(page.getByRole('button', { name: 'Export SKP' })).toBeEnabled();
}

test('malformed project labels, filenames and field types preserve the current unsaved draft', async ({ page }) => {
  const crashes: string[] = [];
  page.on('pageerror', error => crashes.push(error.message));
  await startDraft(page);
  const badName = authoredProject();
  const badFilename = authoredProject();
  const badText = authoredProject();
  const badRows = authoredProject();
  (badName.project.actors[0] as unknown as { name: unknown }).name = { unexpected: 'object label' };
  (badFilename.project as unknown as { filename: unknown }).filename = ['FC_W001.SKP'];
  (badText.project.rows[0] as unknown as { text: unknown }).text = { unexpected: 'object text' };
  (badRows.project as unknown as { rows: unknown }).rows = { unexpected: 'not an array' };
  for (const [index, value] of [badName, badFilename, badText, badRows].entries()) {
    await openJson(page, value, `malformed-${index}.skit.json`);
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(authoredText(page)).toHaveValue('Keep this unsaved draft.');
    await expect(page.locator('.line-row')).toHaveCount(1);
  }
  const saved = JSON.parse((await saveProject(page)).bytes.toString());
  expect(saved.project.rows[0].text).toBe('Keep this unsaved draft.');
  expect(crashes).toEqual([]);
});

test('malformed protected-token labels cannot replace or crash an existing draft', async ({ page }) => {
  const crashes: string[] = [];
  page.on('pageerror', error => crashes.push(error.message));
  await startDraft(page);
  const original = await readFile(fixture('FC_W001.SKP'));
  await openJson(page, {
    format: 'tos-skit-project', version: 1, kind: 'retail', filename: 'FC_W001.SKP',
    original: original.toString('base64'),
    edits: { literals: [], messages: [{ index: 1, tokens: [{ kind: 'protected', hex: '01', label: { invalid: true } }] }] },
  });
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(authoredText(page)).toHaveValue('Keep this unsaved draft.');
  expect(crashes).toEqual([]);
});

test('an authored project missing optional defaults and stage arrays opens with normalized values', async ({ page }) => {
  const crashes: string[] = [];
  page.on('pageerror', error => crashes.push(error.message));
  await startDraft(page);
  await openJson(page, {
    format: 'tos-skit-project', version: 1, kind: 'authored',
    project: { filename: 'FC_W001.SKP', actors: [{ id: 1, textureSlot: 0, x: 320, y: 200 }],
      rows: [{ text: 'A minimal draft.', speaker: 1, durationTicks: 180 }] },
  });
  await expect(page.getByRole('status')).toContainText('Sequence project opened');
  await expect(authoredText(page)).toHaveValue('A minimal draft.');
  await expect(page.getByRole('button', { name: 'Export SKP' })).toBeEnabled();
  const saved = JSON.parse((await saveProject(page)).bytes.toString());
  expect(saved.project.actors[0]).toMatchObject({ name: 'Character 1', scalePercent: 100, rotation: 0, alpha: 255 });
  expect(saved.project.rows[0]).toMatchObject({ voiceId: null, voiceEnabled: false, eyeFrame: -1, mouthFrame: -1, stage: [] });
  expect(typeof saved.project.rows[0].id).toBe('string');
  expect(crashes).toEqual([]);
});

test('missing retail edit arrays normalize without changing the embedded original', async ({ page }) => {
  await page.goto('/');
  const original = await readFile(fixture('FC_W001.SKP'));
  await openJson(page, {
    format: 'tos-skit-project', version: 1, kind: 'retail', filename: 'FC_W001.SKP',
    original: original.toString('base64'), edits: {},
  });
  await expect(page.getByRole('status')).toContainText('Project opened');
  await expect(retailText(page)).toHaveValue('Hello, synthetic skit.');
  const saved = JSON.parse((await saveProject(page)).bytes.toString());
  expect(saved.edits).toEqual({ messages: [], literals: [] });
  expect(Buffer.from(saved.original, 'base64')).toEqual(original);
});

test('a saved authored Unicode draft reopens intact and remains blocked from binary export', async ({ page }) => {
  const crashes: string[] = [];
  page.on('pageerror', error => crashes.push(error.message));
  await startDraft(page);
  const text = 'Keep café and 日本語 in this unfinished draft.';
  await authoredText(page).fill(text);
  await expect(page.getByRole('alert')).toContainText('ASCII');
  await expect(page.getByRole('button', { name: 'Export SKP' })).toBeDisabled();
  const saved = await saveProject(page);
  await openAuthored(page, 'Another imported project.');
  await fileInput(page).setInputFiles({ name: saved.name, mimeType: 'application/json', buffer: saved.bytes });
  await expect(page.getByRole('status')).toContainText('Sequence project opened');
  await expect(authoredText(page)).toHaveValue(text);
  await expect(page.getByRole('alert')).toContainText('ASCII');
  await expect(page.getByRole('button', { name: 'Export SKP' })).toBeDisabled();
  expect(JSON.parse((await saveProject(page)).bytes.toString()).project.rows[0].text).toBe(text);
  expect(crashes).toEqual([]);
});

test('a saved retail Unicode edit reopens intact while the original bytes remain preserved', async ({ page }) => {
  const crashes: string[] = [];
  page.on('pageerror', error => crashes.push(error.message));
  await page.goto('/');
  const original = await readFile(fixture('FC_W001.SKP'));
  await fileInput(page).setInputFiles(fixture('FC_W001.SKP'));
  await expect(page.getByRole('status')).toContainText('Opened FC_W001.SKP');
  const text = 'An unfinished café translation.';
  await retailText(page).fill(text);
  await expect(page.getByRole('alert')).toContainText('ASCII');
  await expect(page.getByRole('button', { name: 'Export SKP' })).toBeDisabled();
  const saved = await saveProject(page);
  await openAuthored(page, 'Another imported project.');
  await fileInput(page).setInputFiles({ name: saved.name, mimeType: 'application/json', buffer: saved.bytes });
  await expect(page.getByRole('status')).toContainText('Project opened');
  await expect(retailText(page)).toHaveValue(text);
  await expect(page.locator('.original-text')).toContainText('Hello, synthetic skit.');
  await expect(page.getByRole('alert')).toContainText('ASCII');
  await expect(page.getByRole('button', { name: 'Export SKP' })).toBeDisabled();
  const reopened = JSON.parse((await saveProject(page)).bytes.toString());
  expect(Buffer.from(reopened.original, 'base64')).toEqual(original);
  expect(reopened.edits.messages[0].tokens[0].text).toBe(text);
  expect(crashes).toEqual([]);
});

test('opening another project followed by Undo restores the previous unsaved draft and Redo returns to the opened project', async ({ page }) => {
  await startDraft(page, 'An unsaved draft that must survive opening another file.');
  await page.getByLabel('Duration (60 Hz ticks)').fill('420');
  await openAuthored(page, 'Another imported project.');
  await expect(authoredText(page)).toHaveValue('Another imported project.');
  await expect(page.getByLabel('Duration (60 Hz ticks)')).toHaveValue('180');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(authoredText(page)).toHaveValue('An unsaved draft that must survive opening another file.');
  await expect(page.getByLabel('Duration (60 Hz ticks)')).toHaveValue('420');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(authoredText(page)).toHaveValue('Another imported project.');
  await expect(page.getByLabel('Duration (60 Hz ticks)')).toHaveValue('180');
});

test('saving another project keeps unload protection for an older unsaved draft until that draft is saved', async ({ page }) => {
  await startDraft(page, 'Draft A still needs to be saved.');
  await openAuthored(page, 'Another imported project.');
  await expect(authoredText(page)).toHaveValue('Another imported project.');
  await saveProject(page);
  const unloadPrevented = () => page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
  await expect.poll(unloadPrevented).toBe(true);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(authoredText(page)).toHaveValue('Draft A still needs to be saved.');
  await saveProject(page);
  await expect.poll(unloadPrevented).toBe(false);
});

test('changing an imported speaker retargets its saved frame override using the bundled animation metadata', async ({ page }) => {
  await page.goto('/');
  const original = await readFile(fixture('FC_W001.SKP'));
  const document = JSON.parse(await readFile(fixture('original.json'), 'utf8'));
  const speaker = document.instructions.find((instruction: { nativeOpcode?: number }) => instruction.nativeOpcode === 0xf1);
  const instructions: object[] = [1, 64, 0].flatMap(value => [
    { kind: 'literal', value }, { kind: 'calculate', opcode: 0 }, { kind: 'argument' },
  ]);
  instructions.push({ kind: 'native', opcode: 0x1d }, { kind: 'calculate', opcode: 0 });
  await openJson(page, {
    format: 'tos-skit-project', version: 1, kind: 'retail', filename: 'FC_W001.SKP',
    original: original.toString('base64'),
    edits: { messages: [], literals: [], insertions: [{ beforePc: speaker.pc + 1, instructions }] },
  });
  await expect(page.getByRole('status')).toContainText('Project opened');
  await expect(page.getByRole('button', { name: 'Export SKP' })).toBeEnabled();
  await page.getByLabel('Speaking character').selectOption('2');
  await expect(page.getByRole('button', { name: 'Export SKP' })).toBeEnabled();
  const saved = JSON.parse((await saveProject(page)).bytes.toString());
  expect(saved.edits.insertions[0].instructions[0]).toEqual({ kind: 'literal', value: 2 });
  expect(saved.edits.insertions[0].instructions[3]).toEqual({ kind: 'literal', value: 64 });
  expect(saved.edits.insertions[0].instructions[6]).toEqual({ kind: 'literal', value: 0 });
  expect(saved.edits.literals).toContainEqual({ pc: speaker.arguments[0].literalPc, value: 2 });
});
