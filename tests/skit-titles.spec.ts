import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { authoredProject } from './fixtures';

const fileInput = (page: Page) => page.locator('input[type="file"][accept=".skp,.json"]');
const title = (page: Page) => page.locator('.document-name .skit-title');
const filename = (page: Page) => page.locator('.document-name .document-filename');
const depressedTitle = 'For Depressed People...';
const id = (page: Page) => page.getByLabel('Skit ID', { exact: true });

test('test-map IDs use canonical selector values, including untitled slots', async ({ page }) => {
  await page.goto('/');
  const ids = await page.evaluate(async () => {
    const { skitId } = await import('/src/skit-titles.ts');
    return ['fc_w085.skp', 'FC_B000.SKP', 'FC_C000.SKP', 'FC_C004.SKP', 'FC_U000.SKP', 'FC_W999.SKP', ''].map(skitId);
  });
  // B000 and C000 also have selector aliases 121 and 351; use their canonical IDs.
  expect(ids).toEqual([685, 250, 1, 5, 450, undefined, undefined]);
});

async function openRetail(page: Page) {
  await page.goto('/');
  const bytes = await readFile(join(process.env.SKIT_TEST_FIXTURES!, 'FC_W001.SKP'));
  await fileInput(page).setInputFiles({ name: 'FC_W085.SKP', mimeType: 'application/octet-stream', buffer: bytes });
  await expect(page.getByRole('status')).toContainText('Opened FC_W085.SKP');
}

async function downloadProject(page: Page, button = 'Save project') {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: button, exact: true }).click();
  const download = await pending;
  const path = await download.path();
  expect(path).not.toBeNull();
  return readFile(path!);
}

test('the original slot title appears beside its filename and survives project reopening under a different name', async ({ page }) => {
  await openRetail(page);
  await expect(title(page)).toHaveText(depressedTitle);
  await expect(filename(page)).toHaveText('FC_W085.SKP');
  await expect(page.getByRole('textbox', { name: 'Edited text 1', exact: true })).toHaveValue('Hello, synthetic skit.');
  await page.getByRole('button', { name: 'Script details', exact: true }).click();
  await expect(page.getByLabel('Original slot title', { exact: true })).toHaveValue(depressedTitle);
  await expect(page.getByLabel('Original slot title', { exact: true })).toHaveAttribute('readonly');
  await expect(id(page)).toHaveValue('685');
  await expect(id(page)).toHaveAttribute('readonly');
  const saved = await downloadProject(page);
  await fileInput(page).setInputFiles({ name: 'unrelated-draft-name.skit.json', mimeType: 'application/json', buffer: saved });
  await expect(page.getByRole('status')).toContainText('Project opened');
  await expect(title(page)).toHaveText(depressedTitle);
  await expect(filename(page)).toHaveText('FC_W085.SKP');
  await expect(id(page)).toHaveValue('685');
});

test('slot titles follow slot edits and undo, and remain visible after conversion to a sequence', async ({ page }) => {
  await openRetail(page);
  await page.getByRole('button', { name: 'Script details', exact: true }).click();
  await page.getByLabel('Existing skit slot filename').fill('FC_W999.SKP');
  await expect(title(page)).toHaveText('Unknown skit title');
  await expect(filename(page)).toHaveText('FC_W999.SKP');
  await expect(id(page)).toHaveValue('Unknown skit ID');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(title(page)).toHaveText(depressedTitle);
  await expect(filename(page)).toHaveText('FC_W085.SKP');
  await expect(id(page)).toHaveValue('685');
  await page.getByText('Sequence editing', { exact: true }).click();
  await page.getByRole('button', { name: 'Edit as sequence', exact: true }).click();
  const original = JSON.parse((await downloadProject(page, 'Save original & edit sequence')).toString());
  expect(original.filename).toBe('FC_W085.SKP');
  await expect(page.getByRole('status')).toContainText('Sequence editing enabled');
  await expect(title(page)).toHaveText(depressedTitle);
  await expect(filename(page)).toHaveText('FC_W085.SKP');
  await expect(page.getByLabel('Original slot title', { exact: true })).toHaveValue(depressedTitle);
  await expect(id(page)).toHaveValue('685');
});

test('authored projects resolve case-insensitive slot names and distinguish a known blank title', async ({ page }) => {
  await page.goto('/');
  const project = authoredProject();
  project.project.filename = 'fc_w085.skp';
  await fileInput(page).setInputFiles({ name: 'my-sequence.skit.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project)) });
  await expect(page.getByRole('status')).toContainText('Sequence project opened');
  await expect(title(page)).toHaveText(depressedTitle);
  await expect(filename(page)).toHaveText('fc_w085.skp');
  await page.getByRole('button', { name: 'Script details', exact: true }).click();
  await expect(id(page)).toHaveValue('685');
  await page.getByLabel('Existing skit slot filename').fill('FC_C004.SKP');
  await expect(title(page)).toHaveText('No English title');
  await expect(filename(page)).toHaveText('FC_C004.SKP');
  await expect(id(page)).toHaveValue('5');
  await page.getByLabel('Existing skit slot filename').fill('FC_C000.SKP');
  await expect(title(page)).toHaveText("What's the Temple Like?");
  await expect(filename(page)).toHaveText('FC_C000.SKP');
  await expect(id(page)).toHaveValue('1');
  await page.getByLabel('Existing skit slot filename').fill('FC_B000.SKP');
  await expect(id(page)).toHaveValue('250');
});
