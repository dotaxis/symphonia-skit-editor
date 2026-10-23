import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { authoredProject } from './fixtures';
import type { SkitDocument } from '../src/types';

/** Shared textures deliberately span separate actor lifetimes and actor IDs. */
async function openSharedPortraits(page: Page, computedPosition = false) {
  await page.goto('/');
  const bytes = await page.evaluate(async computed => {
    const { core } = await import('/src/core.ts');
    const instructions: object[] = [];
    const arrayHandle = (index: number) => [{ kind: 'loadGlobal', offset: 0x678, width: 's32' },
      { kind: 'literal', value: index }, { kind: 'calculate', opcode: 15 }];
    const call = (opcode: number, args: (number | object[])[]) => instructions.push(...args.flatMap(value => [
      ...(Array.isArray(value) ? value : [{ kind: 'literal', value }]),
      { kind: 'calculate', opcode: 0 }, { kind: 'argument' },
    ]), { kind: 'native', opcode });
    const spawn = (actor: number, slot: number, x: number | object[], y = 180) =>
      call(0x57, [actor, arrayHandle(slot === 118 ? 0 : 2), x, y, -1, -1, 0, 255, 255, 255, 255, 0, 0xd0000 | slot]);
    const subtitle = (index: number) => {
      call(0xf4, [6, -1, index]); call(0xf1, [6, 0xae71b]); call(0x64, [0, 180]);
    };
    for (const slot of [118, 125]) {
      instructions.push(...arrayHandle(slot === 118 ? 0 : 2));
      call(0x58, [0xd0000 | slot]);
      instructions.push({ kind: 'calculate', opcode: 16 }, { kind: 'calculate', opcode: 0 });
      call(0x64, [1, arrayHandle(slot === 118 ? 0 : 2)]);
    }
    spawn(9, 118, computed ? [{ kind: 'literal', value: 100 }, { kind: 'literal', value: 0 },
      { kind: 'calculate', opcode: 0x31 }] : 100, 270); spawn(6, 118, 420);
    subtitle(0); subtitle(1);
    call(0x12, [6]); spawn(6, 125, 420); subtitle(2);
    call(0x12, [6]); spawn(6, 118, 420); subtitle(3);
    instructions.push({ kind: 'end' });
    return [...await core('create_skit', JSON.stringify({ instructions,
      messages: ['First appearance.', 'The same appearance continues.', 'Different expression.', 'The original returns.']
        .map(text => [{ kind: 'text', text }]),
    })) as Uint8Array];
  }, computedPosition);
  await page.locator('input[type="file"][accept=".skp,.json"]').setInputFiles({
    name: 'FC_W085.SKP', mimeType: 'application/octet-stream', buffer: Buffer.from(bytes),
  });
  await expect(page.locator('.line-row')).toHaveCount(4);
  await expect(page.getByLabel('Eye animation')).toBeEnabled();
  await expect.poll(async () => (await portraitPixels(page)).hairPixels).toBeGreaterThan(1000);
  return Buffer.from(bytes);
}

async function canvasPoint(page: Page, x = 420, y = 180) {
  const canvas = page.locator('.stage-wrap canvas');
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  return { x: box.x + (x * 1.9 + 356) / 1920 * box.width,
    y: box.y + (y * 2 + 64) / 1080 * box.height };
}

async function chooseOnStage(page: Page, slot: number) {
  await page.getByRole('button', { name: 'Cast & staging', exact: true }).click();
  const point = await canvasPoint(page);
  await page.mouse.click(point.x, point.y);
  const gallery = page.getByRole('dialog', { name: 'Choose a portrait' });
  await expect(gallery).toBeVisible();
  await gallery.getByRole('searchbox').fill('Zelos');
  await gallery.getByRole('button', { name: new RegExp(`^Select portrait ${slot},`) }).click();
  const scope = page.getByRole('dialog', { name: 'Replace portrait?' });
  await expect(scope).toBeVisible();
  return scope;
}

async function exportBytes(page: Page) {
  const button = page.getByRole('button', { name: 'Export SKP', exact: true });
  await expect(button).toBeEnabled();
  const pending = page.waitForEvent('download');
  await button.click();
  const download = await pending;
  return readFile((await download.path())!);
}

async function exportedSpawns(page: Page) {
  const bytes = await exportBytes(page);
  return page.evaluate(async values => {
    const { core } = await import('/src/core.ts');
    const document = await core('parse_skit', new Uint8Array(values)) as SkitDocument;
    return document.instructions.filter(op => op.nativeOpcode === 0x57)
      .map(op => [op.arguments![0].value!, op.arguments![12].value! & 0xffff]);
  }, [...bytes]);
}

async function portraitPixels(page: Page) {
  return page.locator('.stage-wrap canvas').evaluate(async (canvas: HTMLCanvasElement) => {
    // Exclude selection borders and names so row selection cannot change this hash.
    const pixels = canvas.getContext('2d')!.getImageData(984, 210, 340, 400).data;
    let hairPixels = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] > 100 && pixels[i] > pixels[i + 1] * 1.4 && pixels[i] > pixels[i + 2] * 1.3) hairPixels++;
    }
    const digest = await crypto.subtle.digest('SHA-256', pixels);
    return { hairPixels, hash: [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('') };
  });
}

async function dragPortrait(page: Page, from: [number, number], to: [number, number], cancel = false,
  beforeRelease?: () => Promise<void>) {
  const start = await canvasPoint(page, ...from);
  const end = await canvasPoint(page, ...to);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  // Many pointer moves must remain one edit, even after crossing empty space.
  await page.mouse.move(start.x + 55, start.y - 55, { steps: 15 });
  await page.mouse.move(end.x, end.y, { steps: 25 });
  await beforeRelease?.();
  if (cancel) await page.locator('.stage-wrap canvas').dispatchEvent('pointercancel', { pointerId: 1 });
  await page.mouse.up();
}

async function expectPosition(page: Page, id: number, x: number, y: number) {
  await page.locator('.cast-list button').filter({ has: page.locator('.avatar').filter({ hasText: new RegExp(`^${id}$`) }) }).click();
  await expect(page.getByLabel('X position', { exact: true })).toHaveValue(String(x));
  await expect(page.getByLabel('Y position', { exact: true })).toHaveValue(String(y));
}

async function openAuthoredPair(page: Page, timedScale = false) {
  await page.goto('/');
  const draft = authoredProject();
  draft.project.actors = [
    { ...draft.project.actors[0], textureSlot: 118, x: 420, y: 180 },
    { ...draft.project.actors[0], id: 9, name: 'Character 9', textureSlot: 125, x: 100, y: 300 },
  ];
  const project = { ...draft, project: { ...draft.project, rows: [
    { ...draft.project.rows[0], stage: [{ actorId: 1, x: 450, y: 160 },
      ...(timedScale ? [{ actorId: 9, scalePercent: 150, movementTicks: 60 }] : [])] },
  ] } };
  await page.locator('input[type="file"][accept=".skp,.json"]').setInputFiles({
    name: 'synthetic.skit.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project)),
  });
  await expect(page.getByRole('status')).toContainText('Sequence project opened');
  await page.getByRole('button', { name: 'Cast & staging', exact: true }).click();
  await expectPosition(page, 1, 450, 160);
}

test('clicking a preview portrait opens the gallery and cancellation leaves the SKP unchanged', async ({ page }) => {
  const original = await openSharedPortraits(page);
  const scope = await chooseOnStage(page, 120);
  await expect(scope.getByRole('button', { name: 'This appearance', exact: true })).toBeEnabled();
  await expect(scope.getByRole('button', { name: 'All instances', exact: true })).toBeEnabled();
  await scope.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(scope).toHaveCount(0);
  expect(await exportBytes(page)).toEqual(original);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('This appearance changes one spawn lifetime and survives export without changing other uses', async ({ page }) => {
  await openSharedPortraits(page);
  const original = (await portraitPixels(page)).hash;
  const scope = await chooseOnStage(page, 120);
  await scope.getByRole('button', { name: 'This appearance', exact: true }).click();
  await expect(scope).toHaveCount(0);
  await expect.poll(async () => (await portraitPixels(page)).hash).not.toBe(original);
  const replacement = (await portraitPixels(page)).hash;
  await page.getByRole('button', { name: 'Dialogue', exact: true }).click();
  await page.locator('.line-row').nth(1).click();
  await expect.poll(async () => (await portraitPixels(page)).hash).toBe(replacement);
  await page.locator('.line-row').nth(3).click();
  await expect.poll(async () => (await portraitPixels(page)).hash).toBe(original);
  expect(await exportedSpawns(page)).toEqual([[9, 118], [6, 120], [6, 125], [6, 118]]);
  const bytes = await exportBytes(page);
  await page.locator('input[type="file"][accept=".skp,.json"]').setInputFiles({
    name: 'FC_W085.SKP', mimeType: 'application/octet-stream', buffer: bytes,
  });
  await expect.poll(async () => (await portraitPixels(page)).hash).toBe(replacement);
  await page.locator('.line-row').nth(3).click();
  await expect.poll(async () => (await portraitPixels(page)).hash).toBe(original);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('All instances replaces a shared resource across actors and undo restores every use', async ({ page }) => {
  await openSharedPortraits(page);
  const scope = await chooseOnStage(page, 120);
  await scope.getByRole('button', { name: 'All instances', exact: true }).click();
  expect(await exportedSpawns(page)).toEqual([[9, 120], [6, 120], [6, 125], [6, 120]]);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await exportedSpawns(page)).toEqual([[9, 118], [6, 118], [6, 125], [6, 118]]);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  expect(await exportedSpawns(page)).toEqual([[9, 120], [6, 120], [6, 125], [6, 120]]);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('portrait clicks and drags cannot edit the preview outside Cast & staging', async ({ page }) => {
  const original = await openSharedPortraits(page);
  for (const name of ['Dialogue', 'Script details']) {
    await page.getByRole('button', { name, exact: true }).click();
    const point = await canvasPoint(page);
    await page.mouse.click(point.x, point.y);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await dragPortrait(page, [420, 180], [100, 270]);
    await page.keyboard.down('Shift');
    await dragPortrait(page, [420, 180], [100, 270]);
    await page.keyboard.up('Shift');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  }
  expect(await exportBytes(page)).toEqual(original);
  const scope = await chooseOnStage(page, 120);
  await scope.getByRole('button', { name: 'Cancel', exact: true }).click();
});

test('a long retail drag snaps into an empty standard position as one undo step and survives export', async ({ page }) => {
  await openSharedPortraits(page);
  await page.getByRole('button', { name: 'Cast & staging', exact: true }).click();
  // Neither original portrait occupies this standard two-character position.
  await dragPortrait(page, [420, 180], [209, 211]);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expectPosition(page, 6, 200, 200);
  await expectPosition(page, 9, 100, 270);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expectPosition(page, 6, 420, 180);
  await expectPosition(page, 9, 100, 270);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expectPosition(page, 6, 200, 200);
  await expectPosition(page, 9, 100, 270);
  const bytes = await exportBytes(page);
  await page.locator('input[type="file"][accept=".skp,.json"]').setInputFiles({
    name: 'FC_W085.SKP', mimeType: 'application/octet-stream', buffer: bytes,
  });
  await page.getByRole('button', { name: 'Cast & staging', exact: true }).click();
  await expectPosition(page, 6, 200, 200);
  await expectPosition(page, 9, 100, 270);
  await page.getByRole('button', { name: 'Dialogue', exact: true }).click();
  await page.locator('.line-row').nth(3).click();
  await page.getByRole('button', { name: 'Cast & staging', exact: true }).click();
  // The later actor 6 spawn retains its original position.
  await expectPosition(page, 6, 420, 180);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('sequence snapping respects stage overrides and exports only the moved portrait', async ({ page }) => {
  await openAuthoredPair(page);
  await dragPortrait(page, [450, 160], [210, 208]);
  await expectPosition(page, 1, 200, 200);
  await expectPosition(page, 9, 100, 300);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expectPosition(page, 1, 450, 160);
  await expectPosition(page, 9, 100, 300);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expectPosition(page, 1, 200, 200);
  await expectPosition(page, 9, 100, 300);
  await expectPosition(page, 1, 200, 200);
  await page.getByLabel('X position', { exact: true }).fill('225');
  await expectPosition(page, 1, 225, 200);
  await expectPosition(page, 9, 100, 300);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expectPosition(page, 1, 200, 200);
  await expectPosition(page, 9, 100, 300);
  const bytes = await exportBytes(page);
  await page.locator('input[type="file"][accept=".skp,.json"]').setInputFiles({
    name: 'FC_W001.SKP', mimeType: 'application/octet-stream', buffer: bytes,
  });
  await page.getByRole('button', { name: 'Cast & staging', exact: true }).click();
  await expectPosition(page, 1, 200, 200);
  await expectPosition(page, 9, 100, 300);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('Shift-drag swaps both retail positions as one undo step and survives export', async ({ page }) => {
  await openSharedPortraits(page);
  await page.getByRole('button', { name: 'Cast & staging', exact: true }).click();
  await page.keyboard.down('Shift');
  await dragPortrait(page, [420, 180], [100, 270], false, async () => {
    await expect(page.locator('.stage-caption')).toContainText('Release to swap positions');
    await expect(page.getByLabel('X position', { exact: true })).toHaveValue('420');
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
    // Modifier changes update the preview without needing another pointer move.
    await page.keyboard.up('Shift');
    await expect(page.locator('.stage-caption')).toContainText('occupied by');
    await page.keyboard.down('Shift');
    await expect(page.locator('.stage-caption')).toContainText('Release to swap positions');
  });
  await page.keyboard.up('Shift');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expectPosition(page, 6, 100, 270);
  await expectPosition(page, 9, 420, 180);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expectPosition(page, 6, 420, 180);
  await expectPosition(page, 9, 100, 270);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expectPosition(page, 6, 100, 270);
  await expectPosition(page, 9, 420, 180);
  const bytes = await exportBytes(page);
  await page.locator('input[type="file"][accept=".skp,.json"]').setInputFiles({
    name: 'FC_W085.SKP', mimeType: 'application/octet-stream', buffer: bytes,
  });
  await expectPosition(page, 6, 100, 270);
  await expectPosition(page, 9, 420, 180);
  await page.getByRole('button', { name: 'Next line', exact: true }).click();
  await page.getByRole('button', { name: 'Next line', exact: true }).click();
  // The later explicit respawn still has its own coordinates.
  await expectPosition(page, 6, 420, 180);
  await expectPosition(page, 9, 420, 180);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('Shift pressed during a sequence drag swaps the selected-line positions and survives export', async ({ page }) => {
  await openAuthoredPair(page);
  await dragPortrait(page, [450, 160], [100, 300], false, async () => {
    await page.keyboard.down('Shift');
    await expect(page.locator('.stage-caption')).toContainText('Release to swap positions');
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  });
  await page.keyboard.up('Shift');
  await expectPosition(page, 1, 100, 300);
  await expectPosition(page, 9, 450, 160);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expectPosition(page, 1, 450, 160);
  await expectPosition(page, 9, 100, 300);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  const bytes = await exportBytes(page);
  await page.locator('input[type="file"][accept=".skp,.json"]').setInputFiles({
    name: 'FC_W001.SKP', mimeType: 'application/octet-stream', buffer: bytes,
  });
  await expectPosition(page, 1, 100, 300);
  await expectPosition(page, 9, 450, 160);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('releasing Shift before dropping moves only the dragged portrait, and Shift still allows empty positions', async ({ page }) => {
  await openAuthoredPair(page);
  await page.keyboard.down('Shift');
  await dragPortrait(page, [450, 160], [100, 300], false, async () => {
    await expect(page.locator('.stage-caption')).toContainText('Release to swap positions');
    await page.keyboard.up('Shift');
    await expect(page.locator('.stage-caption')).toContainText('occupied by');
  });
  await expectPosition(page, 1, 100, 300);
  await expectPosition(page, 9, 100, 300);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.keyboard.down('Shift');
  await dragPortrait(page, [450, 160], [200, 200]);
  await page.keyboard.up('Shift');
  await expectPosition(page, 1, 200, 200);
  await expectPosition(page, 9, 100, 300);
});

test('Shift-drag refuses a swap when the other portrait has a timed scale change', async ({ page }) => {
  await openAuthoredPair(page, true);
  const original = await exportBytes(page);
  await page.keyboard.down('Shift');
  await dragPortrait(page, [450, 160], [100, 300], false, async () => {
    await expect(page.locator('.stage-caption')).toContainText('timed scale change');
  });
  await page.keyboard.up('Shift');
  await expectPosition(page, 1, 450, 160);
  await expectPosition(page, 9, 100, 300);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  expect(await exportBytes(page)).toEqual(original);
});

test('off-canvas, subtitle, pointer-cancelled and Escape-cancelled drags leave undo history untouched', async ({ page }) => {
  const original = await openSharedPortraits(page);
  await page.getByRole('button', { name: 'Cast & staging', exact: true }).click();
  for (const shift of [false, true]) {
    if (shift) await page.keyboard.down('Shift');
    for (const [target, cancel, escape] of [
      [[-300, -100], false, false], [[320, 430], false, false],
      [[100, 270], true, false], [[100, 270], false, true], [[420, 180], false, false],
    ] as const) {
      await dragPortrait(page, [420, 180], [...target], cancel,
        escape ? async () => { await page.keyboard.press('Escape'); } : undefined);
      await expectPosition(page, 6, 420, 180);
      await expectPosition(page, 9, 100, 270);
      await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
      await expect(page.getByRole('dialog')).toHaveCount(0);
    }
    if (shift) await page.keyboard.up('Shift');
  }
  expect(await exportBytes(page)).toEqual(original);
});

test('dragging a computed retail position cannot create a partial edit', async ({ page }) => {
  const original = await openSharedPortraits(page, true);
  await page.getByRole('button', { name: 'Cast & staging', exact: true }).click();
  await expectPosition(page, 9, 100, 270);
  await expect(page.getByLabel('X position', { exact: true })).toBeDisabled();
  await dragPortrait(page, [100, 270], [200, 200], false, async () => {
    await expect(page.locator('.stage-caption')).toContainText('computed script value');
  });
  // The dragged portrait is editable, but its swap partner is not.
  await page.keyboard.down('Shift');
  await dragPortrait(page, [420, 180], [100, 270], false, async () => {
    await expect(page.locator('.stage-caption')).toContainText('computed script value');
  });
  await page.keyboard.up('Shift');
  await expectPosition(page, 6, 420, 180);
  await expectPosition(page, 9, 100, 270);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await exportBytes(page)).toEqual(original);
});

test('either overlapping portrait can move to an empty standard corner after a later retail respawn', async ({ page }) => {
  await page.goto('/');
  const bytes = await page.evaluate(async () => {
    const { core } = await import('/src/core.ts');
    const instructions: object[] = [];
    const call = (opcode: number, args: number[]) => instructions.push(...args.flatMap(value => [
      { kind: 'literal', value }, { kind: 'calculate', opcode: 0 }, { kind: 'argument' },
    ]), { kind: 'native', opcode });
    const spawn = (actor: number, slot: number, x: number, y: number) =>
      call(0x57, [actor, 0, x, y, -1, -1, 0, 255, 255, 255, 255, 0, 0xd0000 | slot]);
    const subtitle = (index: number) => {
      call(0xf4, [6, -1, index]); call(0xf1, [6, 0xae71b]); call(0x64, [0, 180]);
    };
    spawn(3, 54, 200, 120); spawn(6, 118, 420, 120);
    spawn(7, 118, 200, 300); spawn(8, 125, 420, 300);
    subtitle(0);
    call(0x12, [6]); spawn(6, 125, 420, 120); subtitle(1);
    instructions.push({ kind: 'end' });
    return [...await core('create_skit', JSON.stringify({ instructions,
      messages: ['Before rearranging.', 'A later spawn returns to its scripted corner.']
        .map(text => [{ kind: 'text', text }]),
    })) as Uint8Array];
  });
  await page.locator('input[type="file"][accept=".skp,.json"]').setInputFiles({
    name: 'FC_W085.SKP', mimeType: 'application/octet-stream', buffer: Buffer.from(bytes),
  });
  await page.getByRole('button', { name: 'Cast & staging', exact: true }).click();
  await expectPosition(page, 6, 420, 120);
  await dragPortrait(page, [420, 120], [200, 120]);
  // Occupied destinations are allowed; their existing occupant is unchanged.
  await expectPosition(page, 6, 200, 120);
  await expectPosition(page, 3, 200, 120);
  // Choosing the underlying actor in Cast makes it draggable through the overlap.
  await dragPortrait(page, [200, 120], [420, 120]);
  await expectPosition(page, 3, 420, 120);
  await expectPosition(page, 6, 200, 120);
  await page.getByRole('button', { name: 'Next line', exact: true }).click();
  await expectPosition(page, 3, 420, 120);
  await expectPosition(page, 6, 420, 120);
  await expectPosition(page, 3, 420, 120);
  await dragPortrait(page, [420, 120], [208, 125]);
  await expectPosition(page, 3, 200, 120);
  await expectPosition(page, 6, 420, 120);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expectPosition(page, 3, 420, 120);
  await expectPosition(page, 6, 420, 120);
  await dragPortrait(page, [420, 120], [200, 120]);
  await expectPosition(page, 3, 420, 120);
  await expectPosition(page, 6, 200, 120);
  await expectPosition(page, 7, 200, 300);
  await expectPosition(page, 8, 420, 300);
  const exported = await exportBytes(page);
  await page.locator('input[type="file"][accept=".skp,.json"]').setInputFiles({
    name: 'FC_W085.SKP', mimeType: 'application/octet-stream', buffer: exported,
  });
  await page.getByRole('button', { name: 'Next line', exact: true }).click();
  await page.getByRole('button', { name: 'Cast & staging', exact: true }).click();
  await expectPosition(page, 3, 420, 120);
  await expectPosition(page, 6, 200, 120);
  await expectPosition(page, 7, 200, 300);
  await expectPosition(page, 8, 420, 300);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('sequence portrait clicks offer a selected-line change or every matching resource', async ({ page }) => {
  await page.goto('/');
  const draft = authoredProject();
  draft.project.actors = [
    { ...draft.project.actors[0], textureSlot: 118, x: 420, y: 180 },
    { ...draft.project.actors[0], id: 9, name: 'Character 9', textureSlot: 118, x: 100, y: 180 },
  ];
  const row = draft.project.rows[0];
  const rows = Array.from({ length: 5 }, (_, i) => ({ ...row, id: `row-${i}`, text: `Sequence line ${i + 1}.`,
    stage: i === 3 ? [{ actorId: 1, textureSlot: 125 }] : i === 4 ? [{ actorId: 1, textureSlot: 118 }] : [],
  }));
  const project = { ...draft, project: { ...draft.project, rows } };
  await page.locator('input[type="file"][accept=".skp,.json"]').setInputFiles({
    name: 'synthetic.skit.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project)),
  });
  await expect(page.locator('.line-row')).toHaveCount(5);
  await page.locator('.line-row').nth(1).click();
  let scope = await chooseOnStage(page, 120);
  await scope.getByRole('button', { name: 'This appearance', exact: true }).click();
  async function currentSlot(index: number) {
    await page.getByRole('button', { name: 'Dialogue', exact: true }).click();
    await page.locator('.line-row').nth(index).click();
    await page.getByRole('button', { name: 'Cast & staging', exact: true }).click();
    return page.locator('.cast-list button').filter({ has: page.locator('.avatar').filter({ hasText: /^1$/ }) }).locator('small').textContent();
  }
  const localSlots: (string | null)[] = [];
  for (let i = 0; i < 5; i++) localSlots.push(await currentSlot(i));
  expect(localSlots).toEqual(['Portrait 118', 'Portrait 120', 'Portrait 120', 'Portrait 125', 'Portrait 118']);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByRole('button', { name: 'Dialogue', exact: true }).click();
  await page.locator('.line-row').first().click();
  scope = await chooseOnStage(page, 120);
  await scope.getByRole('button', { name: 'All instances', exact: true }).click();
  const allSlots: (string | null)[] = [];
  for (let i = 0; i < 5; i++) allSlots.push(await currentSlot(i));
  expect(allSlots).toEqual(['Portrait 120', 'Portrait 120', 'Portrait 120', 'Portrait 125', 'Portrait 120']);
  await expect(page.locator('.cast-list button').filter({ has: page.locator('.avatar').filter({ hasText: /^9$/ }) }).locator('small')).toHaveText('Portrait 120');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('preview follows exits, returns, removal and later joins at synchronized dialogue cues', async ({ page }) => {
  await page.goto('/');
  const bytes = await page.evaluate(async () => {
    const { core } = await import('/src/core.ts');
    const instructions: object[] = [];
    const call = (opcode: number, args: (number | object[])[]) => instructions.push(...args.flatMap(value => [
      ...(Array.isArray(value) ? value : [{ kind: 'literal', value }]),
      { kind: 'calculate', opcode: 0 }, { kind: 'argument' },
    ]), { kind: 'native', opcode });
    const spawn = (actor: number, slot: number, x: number) =>
      call(0x57, [actor, 0, x, 180, -1, -1, 0, 255, 255, 255, 255, 0, 0xd0000 | slot]);
    const move = (x: number | object[]) => {
      call(0x16, [3, x, 180, 0, 0x80000000 | 30]); call(0x64, [0, 30]);
    };
    const clip = (index: number) => { call(0x56, [65537 + index]); call(0x64, [15, 1]); };
    spawn(3, 54, 100); spawn(6, 118, 420);
    call(0x39, [3000]); instructions.push({ kind: 'calculate', opcode: 0 });
    clip(0);
    // Retail scripts commonly encode negative coordinates as arithmetic.
    move([{ kind: 'literal', value: 100 }, { kind: 'literal', value: 500 }, { kind: 'calculate', opcode: 0x32 }]);
    clip(1); move(100); clip(2);
    call(0x12, [3]); clip(3); spawn(3, 54, 100); clip(4);
    instructions.push({ kind: 'end' }, { kind: 'label', name: 'subtitles' });
    for (let index = 0; index < 5; index++) {
      call(0x64, [17, 65537 + index]); call(0xf4, [6, -1, index]); call(0xf1, [6, 0xae71b]);
    }
    instructions.push({ kind: 'end' });
    return [...await core('create_skit', JSON.stringify({ instructions,
      entries: [{ kind: 2, id: 3000, label: 'subtitles' }],
      messages: ['Both here.', 'Genis left.', 'Genis returned.', 'Genis removed.', 'Genis joined again.']
        .map(text => [{ kind: 'text', text }]),
    })) as Uint8Array];
  });
  await page.locator('input[type="file"][accept=".skp,.json"]').setInputFiles({
    name: 'FC_W085.SKP', mimeType: 'application/octet-stream', buffer: Buffer.from(bytes),
  });
  await expect(page.locator('.line-row')).toHaveCount(5);
  const greenPixels = () => page.locator('.stage-wrap canvas').evaluate((canvas: HTMLCanvasElement) => {
    const pixels = canvas.getContext('2d')!.getImageData(376, 210, 340, 400).data;
    let count = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 1] > 80 && pixels[i + 1] > pixels[i] * 1.1 && pixels[i + 1] > pixels[i + 2] * 1.2) count++;
    }
    return count;
  });
  for (const [index, present] of [true, false, true, false, true].entries()) {
    await page.getByRole('button', { name: 'Dialogue', exact: true }).click();
    await page.locator('.line-row').nth(index).click();
    if (present) await expect.poll(greenPixels).toBeGreaterThan(1000);
    else {
      await expect.poll(greenPixels).toBe(0);
      await page.getByRole('button', { name: 'Cast & staging', exact: true }).click();
      const point = await canvasPoint(page, 100, 180);
      await page.mouse.click(point.x, point.y);
      await expect(page.getByRole('dialog')).toHaveCount(0);
    }
  }
  await expect(page.getByRole('alert')).toHaveCount(0);
});
