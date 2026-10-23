import type { AuthoredProject } from './types';

// These are SKITDATA portrait slots, not the script's freely assigned actor IDs.
const portraits: readonly [first: number, last: number, name: string][] = [
  [0, 11, 'Lloyd'],
  [21, 31, 'Colette'], [41, 42, 'Colette'], [45, 47, 'Colette'],
  [54, 66, 'Genis'],
  [75, 84, 'Raine'],
  [96, 105, 'Sheena'],
  [117, 128, 'Zelos'],
  [138, 149, 'Presea'],
  [159, 167, 'Regal'],
  [180, 186, 'Kratos'],
  [201, 203, 'Mithos'], [204, 204, 'Corrine'], [205, 205, 'Noishe'],
];

export function characterName(slot: number | undefined): string | undefined {
  if (slot === undefined || !Number.isInteger(slot)) return undefined;
  return portraits.find(([first, last]) => slot >= first && slot <= last)?.[2];
}

/** Older projects saved this placeholder instead of an explicit label choice. */
export function automaticLabel(actorId: number, label?: string): boolean {
  return label === undefined || !label.trim() || label === `Character ${actorId}`;
}

export function actorName(actorId: number, slot?: number, label?: string): string {
  return automaticLabel(actorId, label) ? characterName(slot) ?? `Actor ${actorId}` : label!;
}

/** Apply appearance changes once in row order so later rows cannot rename earlier ones. */
export function sequenceSpeakerNames(project: AuthoredProject): string[] {
  const actors = new Map(project.actors.map(actor => [actor.id, {
    slot: actor.textureSlot, label: actor.name,
  }]));
  return project.rows.map(row => {
    for (const change of row.stage ?? []) {
      const actor = actors.get(change.actorId), slot = change.textureSlot;
      // Match the stage preview's handling of recoverable, unfinished drafts.
      if (actor && slot !== undefined && Number.isInteger(slot) && slot >= 0 && slot < 222) actor.slot = slot;
    }
    const speaker = actors.get(row.speaker);
    return actorName(row.speaker, speaker?.slot, speaker?.label);
  });
}
