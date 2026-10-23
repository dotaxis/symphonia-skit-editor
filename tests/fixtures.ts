import { expect, type Page } from '@playwright/test';

/** Synthetic editor projects keep browser tests independent of retail skit files. */
export function authoredProject(text = 'Imported draft.') {
  return {
    format: 'tos-skit-project', version: 1, kind: 'authored',
    project: {
      filename: 'FC_W001.SKP',
      actors: [{ id: 1, name: 'Character 1', textureSlot: 0, x: 320, y: 200,
        scalePercent: 100, rotation: 0, alpha: 255 }],
      rows: [{ id: 'row-one', text, speaker: 1, durationTicks: 180,
        voiceId: null, voiceEnabled: false, eyeFrame: -1, mouthFrame: -1, stage: [] }],
    },
  };
}

export async function openAuthored(page: Page, text = 'Imported draft.') {
  await page.locator('input[type="file"][accept=".skp,.json"]').setInputFiles({
    name: 'synthetic.skit.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(authoredProject(text))),
  });
  await expect(page.getByRole('status')).toContainText('Sequence project opened');
}
