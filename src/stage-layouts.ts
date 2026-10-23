export interface StagePosition { x: number; y: number }

/**
 * The most frequent complete layout for each on-screen cast size in the PC
 * corpus. Coordinates are native skit units, before the preview's transform.
 * See research/stage-layouts.json and scripts/audit-stage-layouts.mjs for the
 * observations. Small scripted offsets are not additional standard anchors.
 */
const layouts: Readonly<Record<number, readonly (readonly [number, number])[]>> = {
  1: [[320, 200]],
  2: [[200, 200], [420, 200]],
  3: [[210, 120], [430, 120], [320, 300]],
  4: [[200, 120], [420, 120], [200, 300], [420, 300]],
  5: [[180, 120], [440, 120], [310, 220], [180, 320], [440, 320]],
  6: [[144, 76], [484, 76], [232, 192], [414, 192], [144, 307], [484, 307]],
  7: [[174, 76], [454, 76], [86, 192], [316, 192], [560, 192], [174, 307], [454, 307]],
};

/**
 * Keep empty standard locations available after overlaps or edits. Count
 * visible actors, not occupied points; off-screen departing actors do not
 * belong to that count. Add the unedited cue's original positions separately
 * so unusual retail arrangements remain reachable. Unsupported positive cast
 * sizes use the union of observed standard layouts rather than an invented grid.
 */
export function standardStagePositions(count: number): StagePosition[] {
  if (!Number.isSafeInteger(count) || count <= 0) return [];
  const positions = layouts[count] ?? Object.values(layouts).flat();
  return uniqueStagePositions(positions.map(([x, y]) => ({ x, y })));
}

/** Combine standard, original-cue and edited positions without duplicate guides. */
export function uniqueStagePositions(positions: readonly StagePosition[]): StagePosition[] {
  const unique = new Map<string, StagePosition>();
  for (const { x, y } of positions) {
    if (Number.isFinite(x) && Number.isFinite(y)) unique.set(`${x},${y}`, { x, y });
  }
  return [...unique.values()];
}

/** Nearest anchor within the drop radius, measured in native skit units. */
export function nearestStagePosition(point: StagePosition, positions: readonly StagePosition[], maxDistance = 80): StagePosition | undefined {
  if (![point.x, point.y].every(Number.isFinite) || Number.isNaN(maxDistance) || maxDistance < 0) return undefined;
  let best: StagePosition | undefined, distance = maxDistance;
  for (const position of positions) {
    if (![position.x, position.y].every(Number.isFinite)) continue;
    const next = Math.hypot(point.x - position.x, point.y - position.y);
    if (next <= distance && (!best || next < distance)) { best = position; distance = next; }
  }
  return best && { ...best };
}
