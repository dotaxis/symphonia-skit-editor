import { expect, test } from '@playwright/test';
import { nearestStagePosition, standardStagePositions, uniqueStagePositions } from '../src/stage-layouts';

test('standard layouts preserve empty slots instead of deriving anchors from occupied positions', () => {
  // The reported four-person overlap must leave every corner available.
  const positions = standardStagePositions(4);
  expect(positions).toEqual([{ x: 200, y: 120 }, { x: 420, y: 120 }, { x: 200, y: 300 }, { x: 420, y: 300 }]);
  expect(nearestStagePosition({ x: 207, y: 113 }, positions)).toEqual({ x: 200, y: 120 });
  expect(standardStagePositions(1)).toEqual([{ x: 320, y: 200 }]);
  expect(standardStagePositions(2)).toEqual([{ x: 200, y: 200 }, { x: 420, y: 200 }]);
  expect(standardStagePositions(3)).toEqual([{ x: 210, y: 120 }, { x: 430, y: 120 }, { x: 320, y: 300 }]);
});

test('larger casts use observed five-, six-, and seven-person arrangements', () => {
  expect(standardStagePositions(5)).toEqual([
    { x: 180, y: 120 }, { x: 440, y: 120 }, { x: 310, y: 220 }, { x: 180, y: 320 }, { x: 440, y: 320 },
  ]);
  expect(standardStagePositions(6)).toEqual([
    { x: 144, y: 76 }, { x: 484, y: 76 }, { x: 232, y: 192 }, { x: 414, y: 192 }, { x: 144, y: 307 }, { x: 484, y: 307 },
  ]);
  expect(standardStagePositions(7)).toEqual([
    { x: 174, y: 76 }, { x: 454, y: 76 }, { x: 86, y: 192 }, { x: 316, y: 192 }, { x: 560, y: 192 }, { x: 174, y: 307 }, { x: 454, y: 307 },
  ]);
  const fallback = standardStagePositions(8);
  expect(fallback).toEqual(expect.arrayContaining(standardStagePositions(7)));
  expect(fallback).toEqual(expect.arrayContaining(standardStagePositions(1)));
  expect(new Set(fallback.map(point => `${point.x},${point.y}`)).size).toBe(fallback.length);
});

test('drop radius selects a nearby anchor, rejects distant drops, and permits original special anchors', () => {
  const anchors = [...standardStagePositions(3), { x: 310, y: 220 }];
  expect(nearestStagePosition({ x: 303, y: 211 }, anchors)).toEqual({ x: 310, y: 220 });
  expect(nearestStagePosition({ x: 100, y: 350 }, anchors)).toBeUndefined();
  expect(nearestStagePosition({ x: 100, y: 350 }, anchors, Infinity)).toEqual({ x: 320, y: 300 });
  expect(nearestStagePosition({ x: 290, y: 120 }, standardStagePositions(3))).toEqual({ x: 210, y: 120 });
  expect(nearestStagePosition({ x: 291, y: 120 }, standardStagePositions(3))).toBeUndefined();
  expect(nearestStagePosition({ x: 200, y: 200 }, standardStagePositions(2), 0)).toEqual({ x: 200, y: 200 });
  expect(nearestStagePosition({ x: NaN, y: 0 }, anchors)).toBeUndefined();
  expect(nearestStagePosition({ x: 0, y: 0 }, anchors, -1)).toBeUndefined();
  expect(nearestStagePosition({ x: 0, y: 0 }, [{ x: Infinity, y: 0 }])).toBeUndefined();
  expect(standardStagePositions(0)).toEqual([]);
  expect(standardStagePositions(NaN)).toEqual([]);
  expect(uniqueStagePositions([...anchors, { x: 310, y: 220 }, { x: NaN, y: 0 }])).toEqual(anchors);
});
