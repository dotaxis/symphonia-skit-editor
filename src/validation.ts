import type { AnimationCatalog } from './assets';
import { effectiveInstructions, portraits } from './model';
import { actorName } from './characters';
import type { Session } from './types';

/** An original actor can switch portrait resources later. A persistent frame
 * override must fit every known resource it may use, not just its first image. */
export function safeFrames(session: Session, actor: number, catalog?: AnimationCatalog) {
  if (!catalog) return undefined;
  const slots = new Set<number>();
  for (const instruction of effectiveInstructions(session)) {
    const args = instruction.arguments ?? [];
    if (instruction.nativeOpcode === 0x57 && args[0]?.value === undefined) return undefined;
    if (instruction.nativeOpcode === 0x57 && args[0]?.value === actor) {
      if (args[12]?.value === undefined) return undefined;
      slots.add(args[12].value & 0xffff);
    }
    if (instruction.nativeOpcode === 0x1d && args[0]?.value === actor && args[1]?.value === 63) {
      if (args[2]?.value === undefined) return undefined;
      slots.add(args[2].value & 0xffff);
    }
  }
  if (!slots.size) return undefined;
  let eye = Infinity, mouth = Infinity;
  for (const slot of slots) {
    const animation = catalog.slots[slot]; if (!animation) return undefined;
    eye = Math.min(eye, animation.channels.find(channel => channel.tag === 0x7000)?.frames.length ?? 0);
    mouth = Math.min(mouth, animation.channels.find(channel => channel.tag === 0x7003)?.frames.length ?? 0);
  }
  return { eye, mouth };
}

export function validateRetailFrames(session: Session, catalog?: AnimationCatalog) {
  for (const insertion of session.edits.insertions ?? []) {
    const args: number[] = []; let pending: number | undefined;
    for (const raw of insertion.instructions) {
      const instruction = raw as {kind: string; value?: number; opcode?: number};
      if (instruction.kind === 'literal') pending = instruction.value;
      else if (instruction.kind === 'argument') { args.push(pending ?? NaN); pending = undefined; }
      else if (instruction.kind === 'native') {
        if (instruction.opcode === 0x1d && (args[1] === 64 || args[1] === 65) && args[2] >= 0) {
          const bounds = safeFrames(session, args[0], catalog);
          if (!bounds) throw new Error(catalog
            ? 'Cannot validate this actor’s portrait resources. Remove the saved facial frame override or restore literal resource references before export.'
            : 'Portrait animation data is not loaded. Reload the editor before exporting facial frame overrides.');
          const count = args[1] === 64 ? bounds.eye : bounds.mouth;
          if (!Number.isInteger(args[2]) || args[2] >= count) throw new Error(`${actorName(args[0], portraits(session).find(actor => actor.actorId === args[0])?.resourceId)} frame override exceeds a portrait animation used by this skit.`);
        }
        args.length = 0;
      }
    }
  }
}
