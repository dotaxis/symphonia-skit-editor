import { expect, test, type Page } from '@playwright/test';
import { loopingPortraitFixture } from './looping-portrait-fixture';
import { readFile } from 'node:fs/promises';

/** A synthetic two-context program with several subtitles sharing one voice. */
async function openChangingPortraits(page: Page) {
  await page.goto('/');
  const bytes = await page.evaluate(async () => {
    const { core } = await import('/src/core.ts');
    const instructions: object[] = [];
    const call = (opcode: number, args: number[]) => {
      instructions.push(...args.flatMap(value => [
        { kind: 'literal', value }, { kind: 'calculate', opcode: 0 }, { kind: 'argument' },
      ]), { kind: 'native', opcode });
    };
    const spawn = (actor: number, slot: number, x: number) => {
      call(0x57, [actor, 0, x, 180, -1, -1, 0, 255, 255, 255, 255, 0, 0xd0000 | slot]);
    };
    const replace = (slot: number) => { call(0x12, [6]); spawn(6, slot, 420); };
    const subtitle = (index: number) => { call(0xf4, [6, -1, index]); call(0xf1, [6, 0xae71b]); };
    const eyes = (frame: number) => {
      call(0x1d, [6, 64, frame]); instructions.push({ kind: 'calculate', opcode: 0 });
    };
    for (const slot of [118, 125, 117, 123, 54]) {
      call(0x58, [0xd0000 | slot]); instructions.push({ kind: 'calculate', opcode: 0 });
    }
    spawn(3, 54, 100); spawn(6, 118, 420);
    call(0x39, [3000]); instructions.push({ kind: 'calculate', opcode: 0 });
    call(0x56, [65537]); call(0x64, [15, 1]);
    replace(125); call(0x56, [65538]); call(0x64, [15, 1]);
    replace(117); call(0x56, [65539]);
    call(0x59, [165]); replace(123); call(0x64, [15, 1]);
    instructions.push({ kind: 'end' }, { kind: 'label', name: 'subtitles' });
    call(0x64, [17, 65537]); subtitle(0);
    call(0x64, [17, 65538]); subtitle(1);
    call(0x64, [17, 65539]); subtitle(2);
    call(0x59, [170]); subtitle(3); eyes(1);
    call(0x59, [547]); subtitle(4); eyes(-1);
    instructions.push({ kind: 'end' });
    const messages = ['First expression.', 'Second expression.', 'Third expression.',
      'Later shared-clip expression.', 'Shared-clip eyes restored.'];
    const result = await core('create_skit', JSON.stringify({ instructions,
      entries: [{ kind: 2, id: 3000, label: 'subtitles' }],
      messages: messages.map(text => [{ kind: 'text', text }]),
    })) as Uint8Array;
    return [...result];
  });
  await page.locator('input[type="file"][accept=".skp,.json"]').setInputFiles({
    name: 'FC_W085.SKP', mimeType: 'application/octet-stream', buffer: Buffer.from(bytes),
  });
  await expect(page.locator('.line-row')).toHaveCount(5);
  await expect(page.getByLabel('Eye animation')).toBeEnabled();
}

async function portraitPixels(page: Page) {
  return page.locator('.stage-wrap canvas').evaluate(async (canvas: HTMLCanvasElement) => {
    // The fixed crop contains Zelos, excluding subtitles, labels, selection
    // borders and the other actor. Red hair also distinguishes a loaded image
    // from the renderer's temporary neutral placeholder.
    const pixels = canvas.getContext('2d')!.getImageData(984, 210, 340, 400).data;
    let hairPixels = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] > 100 && pixels[i] > pixels[i + 1] * 1.4 && pixels[i] > pixels[i + 2] * 1.3) hairPixels++;
    }
    const digest = await crypto.subtle.digest('SHA-256', pixels);
    return { hairPixels, hash: [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('') };
  });
}

async function selectPortraitRow(page: Page, row: number, slot: number) {
  await page.getByRole('button', { name: 'Dialogue', exact: true }).click();
  await page.locator('.line-row').nth(row).click();
  await page.getByRole('button', { name: 'Cast & staging', exact: true }).click();
  await expect(page.locator('.cast-list button').filter({ hasText: 'Zelos' }).locator('small')).toHaveText(`Portrait ${slot}`);
  await expect.poll(async () => (await portraitPixels(page)).hairPixels).toBeGreaterThan(1000);
  return (await portraitPixels(page)).hash;
}

test('retail row selection renders replacements and original eye cues across parallel contexts', async ({ page }) => {
  await openChangingPortraits(page);
  const hashes: string[] = [];
  for (const [row, slot] of [118, 125, 117, 123, 123].entries()) {
    hashes.push(await selectPortraitRow(page, row, slot));
  }
  // The final two rows use the same resource but different original eye cues.
  expect(new Set(hashes).size).toBe(5);
  expect(await selectPortraitRow(page, 3, 123)).toBe(hashes[3]);
  expect(await selectPortraitRow(page, 0, 118)).toBe(hashes[0]);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('replacing a later resource updates its preview and undo restores the original expression', async ({ page }) => {
  await openChangingPortraits(page);
  const original = await selectPortraitRow(page, 1, 125);
  await page.getByLabel('Script portrait resource').selectOption('125');
  await page.getByRole('button', { name: 'Browse portraits', exact: true }).click();
  const gallery = page.getByRole('dialog', { name: 'Choose a portrait' });
  await gallery.getByRole('searchbox').fill('Zelos');
  await gallery.getByRole('button', { name: /^Select portrait 120,/ }).click();
  const changed = await selectPortraitRow(page, 1, 120);
  expect(changed).not.toBe(original);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await selectPortraitRow(page, 1, 125)).toBe(original);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  expect(await selectPortraitRow(page, 1, 120)).toBe(changed);
  await selectPortraitRow(page, 0, 118);
  await selectPortraitRow(page, 2, 117);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

for (const [filename, name, first, next] of [
  ['FC_C000.SKP', 'Lloyd', 0, 2], ['FC_B006.SKP', 'Raine', 75, 76], ['FC_U000.SKP', 'Presea', 138, 141],
] as const) test(`${name}'s portrait and eyes update after staging loops in ${filename}`, async ({ page }) => {
  await page.goto('/');
  const bytes = await page.evaluate(async spec => {
    const { core } = await import('/src/core.ts');
    return [...await core('create_skit', JSON.stringify(spec)) as Uint8Array];
  }, loopingPortraitFixture([{ id: 25, first, next, x: 320, y: 200 }]));
  const input = page.locator('input[type="file"][accept=".skp,.json"]');
  await input.setInputFiles({ name: filename, mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) });
  await expect(page.locator('.line-row')).toHaveCount(3);
  const pixels = () => page.locator('.stage-wrap canvas').evaluate((canvas: HTMLCanvasElement) => {
    const data = canvas.getContext('2d')!.getImageData(804, 270, 320, 380).data;
    let bright = 0, hash = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 170 && data[i + 1] > 150 && data[i + 2] > 110) bright++;
      hash = Math.imul(hash, 31) + data[i] + data[i + 1] + data[i + 2] | 0;
    }
    return { bright, hash };
  });
  const row = async (index: number, slot: number) => {
    await page.getByRole('button', { name: 'Dialogue', exact: true }).click();
    await page.locator('.line-row').nth(index).click();
    await page.getByRole('button', { name: 'Cast & staging', exact: true }).click();
    await expect(page.locator('.cast-list button').filter({ hasText: name }).locator('small')).toHaveText(`Portrait ${slot}`);
    await expect.poll(async () => (await pixels()).bright).toBeGreaterThan(1000);
    return (await pixels()).hash;
  };
  const initial = await row(0, first), held = await row(1, next), automatic = await row(2, next);
  expect(new Set([initial, held, automatic]).size).toBe(3);
  expect(await row(0, first)).toBe(initial);
  expect(await row(1, next)).toBe(held);
  await page.getByRole('button', { name: 'Dialogue', exact: true }).click();
  await page.getByLabel('Mouth animation', { exact: true }).selectOption('1');
  const edited = await row(1, next);
  expect(edited).not.toBe(held);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await row(1, next)).toBe(held);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  expect(await row(1, next)).toBe(edited);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export SKP', exact: true }).click();
  const exported = await readFile((await (await download).path())!);
  await input.setInputFiles({ name: filename, mimeType: 'application/octet-stream', buffer: exported });
  expect(await row(1, next)).toBe(edited);
  await expect(page.getByRole('alert')).toHaveCount(0);
});
