import { expect, test } from '@playwright/test';
import { projectStage } from '../src/projection';
import type { AuthoredProject, AuthoredLine } from '../src/types';

function line(patch: Partial<AuthoredLine> = {}): AuthoredLine {
  return { id: 'line', text: '', speaker: 1, voiceId: null, voiceEnabled: false,
    durationTicks: 120, eyeFrame: -1, mouthFrame: -1, stage: [], ...patch };
}
function project(rows: AuthoredLine[]): AuthoredProject {
  return { filename: 'FC_W001.SKP', actors: [
    { id: 1, name: 'One', textureSlot: 0, x: 100, y: 200, scalePercent: 100, rotation: 0, alpha: 255 },
    { id: 2, name: 'Two', textureSlot: 25, x: 400, y: 200, scalePercent: 100, rotation: 0, alpha: 255 },
  ], rows };
}

test('seeking interpolates current movement and scale, preserving completed prior rows', () => {
  const value = project([
    line({ stage: [{ actorId: 1, x: 300, y: 400, scalePercent: 200, movementTicks: 120 }] }),
    line({ speaker: 2, stage: [{ actorId: 1, x: 500, movementTicks: 120 }] }),
  ]);
  const original = JSON.stringify(value);
  expect(projectStage(value, 0, 1)[0]).toMatchObject({ x: 200, y: 300, scale: 1.5 });
  expect(projectStage(value, 1, 0)[0]).toMatchObject({ x: 300, y: 400, scale: 2, animationStartSeconds: -2 });
  expect(projectStage(value, 1, 1)[0]).toMatchObject({ x: 400, y: 400, scale: 2 });
  expect(projectStage(value, 1, 100)[0].x).toBe(500);
  expect(projectStage(value, 0, -1)[0].x).toBe(100);
  expect(JSON.stringify(value)).toBe(original);
});

test('texture replacement supports movement and fades from zero opacity', () => {
  const value = project([line({ stage: [{ actorId: 1, textureSlot: 1, x: 300, alpha: 200,
    fadeTicks: 120, movementTicks: 120, scalePercent: 50, rotation: 30 }] })]);
  expect(projectStage(value, 0, 0)[0]).toMatchObject({ slot: 1, x: 100, alpha: 0, scale: 0.5, rotation: 30 });
  expect(projectStage(value, 0, 1)[0]).toMatchObject({ slot: 1, x: 200, alpha: 100 });
  expect(projectStage(value, 0, 2)[0]).toMatchObject({ x: 300, alpha: 200 });
});

test('hiding, showing, and texture replacement preserve targets and reset animation age', () => {
  const value = project([
    line({ eyeFrame: 1, mouthFrame: 2 }),
    line({ speaker: 2, stage: [{ actorId: 1, visible: false, x: 250 }] }),
    line({ speaker: 2, stage: [{ actorId: 1, visible: true, textureSlot: 2 }] }),
  ]);
  expect(projectStage(value, 1, 1)[0]).toMatchObject({ visible: false, x: 250, eyeFrame: 1, mouthFrame: 2 });
  expect(projectStage(value, 2, 0)[0]).toMatchObject({ visible: true, x: 250, slot: 2,
    eyeFrame: -1, mouthFrame: -1, animationStartSeconds: 0 });
});

test('forced frame overrides persist by actor and malformed overrides fall back to automatic', () => {
  const value = project([
    line({ eyeFrame: 1, mouthFrame: 2 }),
    line({ speaker: 2, eyeFrame: 255, mouthFrame: -2 }),
    line({ eyeFrame: -1, mouthFrame: -1 }),
  ]);
  expect(projectStage(value, 1, 0)[0]).toMatchObject({ eyeFrame: 1, mouthFrame: 2 });
  expect(projectStage(value, 1, 0)[1]).toMatchObject({ eyeFrame: -1, mouthFrame: -1 });
  expect(projectStage(value, 2, 0)[0]).toMatchObject({ eyeFrame: -1, mouthFrame: -1 });
});
