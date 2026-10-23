import { expect, test, type Page } from '@playwright/test';
import { authoredProject } from './fixtures';

async function openVoicedProject(page: Page) {
  await page.goto('/');
  const draft = authoredProject('This line can preview without optional audio.');
  const project = {
    ...draft,
    project: {
      ...draft.project,
      rows: draft.project.rows.map(row => ({ ...row, voiceId: 131073, voiceEnabled: true, durationTicks: 600 })),
    },
  };
  await page.locator('input[type="file"][accept=".skp,.json"]').setInputFiles({
    name: 'voiced.skit.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project)),
  });
  await expect(page.getByRole('status')).toContainText('Sequence project opened');
}

// A valid one-entry AWB index. Its unused payload does not need to contain audio.
function unrelatedVoiceBank() {
  const bytes = Buffer.alloc(27);
  bytes.set([65, 70, 83, 50, 1, 4, 2, 0]);
  bytes.writeUInt32LE(1, 8);
  bytes.writeUInt16LE(1, 12);
  bytes.writeUInt16LE(1, 16);
  bytes.writeUInt32LE(26, 18);
  bytes.writeUInt32LE(27, 22);
  return bytes;
}

async function expectMissingBankNotice(page: Page) {
  await expect(page.getByRole('status')).toContainText(/Load CHT_DISC_2\.AWB.*Voices/);
  await expect(page.getByRole('status')).not.toContainText('Error:');
  await expect(page.getByRole('alert')).toHaveCount(0);
}

test('preview uses one timing mode and keeps playing when optional voice banks are absent', async ({ page }) => {
  await openVoicedProject(page);
  await expect(page.getByRole('combobox', { name: 'Preview timing' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Play preview', exact: true }).click();
  await expectMissingBankNotice(page);
  await expect.poll(async () => Number(await page.getByRole('slider', { name: 'Preview playhead' }).inputValue())).toBeGreaterThan(0.2);
  await expect(page.getByRole('button', { name: 'Pause preview', exact: true })).toBeVisible();
});

test('listening and fitting duration identify the missing bank without treating it as an error', async ({ page }) => {
  await openVoicedProject(page);
  await page.getByRole('button', { name: 'Voices', exact: true }).click();
  await page.locator('input[type="file"][accept=".awb"]').setInputFiles({
    name: 'CHT_DISC_1.AWB', mimeType: 'application/octet-stream', buffer: unrelatedVoiceBank(),
  });
  await expect(page.getByRole('status')).toContainText('Loaded 1 voice banks.');
  await page.getByRole('button', { name: 'Close voices', exact: true }).click();
  await page.getByRole('button', { name: 'Listen' }).click();
  await expectMissingBankNotice(page);
  await page.getByRole('button', { name: 'Dismiss notice', exact: true }).click();
  await page.getByRole('button', { name: 'Fit duration to voice', exact: true }).click();
  await expectMissingBankNotice(page);
  await expect(page.getByLabel('Duration (60 Hz ticks)')).toHaveValue('600');
});

test('a malformed selected voice bank still reports a genuine import error', async ({ page }) => {
  await openVoicedProject(page);
  await page.getByRole('button', { name: 'Voices', exact: true }).click();
  await page.locator('input[type="file"][accept=".awb"]').setInputFiles({
    name: 'CHT_DISC_2.AWB', mimeType: 'application/octet-stream', buffer: Buffer.from('invalid bank'),
  });
  await expect(page.getByRole('alert')).toContainText('CHT_DISC_2.AWB');
  await expect(page.getByRole('alert')).toContainText('Unsupported AWB header');
  await expect(page.getByRole('status')).toHaveCount(0);
});
