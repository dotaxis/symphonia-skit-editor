import type { StageActor } from './Stage';
import type { RetailStageActor } from './retail-projection';
import type { Argument, AuthoredProject, EditSet, Session } from './types';

function pair<T extends StageActor>(actors: T[], firstId: number, secondId: number): [T, T] {
  const first = actors.find(actor => actor.id === firstId), second = actors.find(actor => actor.id === secondId);
  if (!first || !second) throw new Error('Both portraits must be present in this preview.');
  if (![first.x, first.y, second.x, second.y].every(Number.isFinite)) {
    throw new Error('Both portrait positions must be known before they can be swapped.');
  }
  return [first, second];
}

function setRetailPositions(session: Session, actors: RetailStageActor[], targets: Map<number, Position>): EditSet {
  const writes = new Map<number, number>();
  function coordinate(argument: Argument | undefined, current: number, target: number) {
    if (current === target) return;
    if (!argument?.editable || argument.literalPc === undefined) {
      throw new Error('This position uses a computed script value and cannot be moved here.');
    }
    if (!Number.isSafeInteger(target)) throw new Error('Portrait positions must be whole numbers.');
    if (writes.has(argument.literalPc) && writes.get(argument.literalPc) !== target) {
      throw new Error('These positions share a script value and cannot be moved independently.');
    }
    writes.set(argument.literalPc, target);
  }
  for (const [id, target] of targets) {
    const actor = actors.find(item => item.id === id);
    if (!actor) throw new Error('The portrait must be present in this preview.');
    if (![actor.x, actor.y, target.x, target.y].every(Number.isFinite)) throw new Error('Portrait positions must be known.');
    coordinate(actor.xArgument, actor.x, target.x);
    coordinate(actor.yArgument, actor.y, target.y);
  }
  if (!writes.size) return session.edits;
  if (!session.document.codeEditable) throw new Error('This script does not support position edits.');

  // A shared literal may also control an unchanged axis or another actor.
  // Reject the proposal instead of moving another actor or an unchanged axis.
  for (const actor of actors) {
    const target = targets.get(actor.id) ?? actor;
    for (const axis of ['x', 'y'] as const) {
      const pc = actor[axis === 'x' ? 'xArgument' : 'yArgument']?.literalPc;
      if (pc !== undefined && writes.has(pc) && writes.get(pc) !== target[axis]) {
        throw new Error('These positions share a script value and cannot be moved independently.');
      }
    }
  }
  return { ...session.edits, literals: [
    ...session.edits.literals.filter(edit => !writes.has(edit.pc)),
    ...[...writes].map(([pc, value]) => ({ pc, value })),
  ] };
}

/** Move one placement atomically; an occupied destination does not move its occupant. */
export function setRetailPosition(session: Session, actors: RetailStageActor[], actorId: number, x: number, y: number): EditSet {
  return setRetailPositions(session, actors, new Map([[actorId, { x, y }]]));
}

/** Prepare a complete position swap before adding a single undo entry. */
export function swapRetailPositions(session: Session, actors: RetailStageActor[], firstId: number, secondId: number): EditSet {
  const [first, second] = pair(actors, firstId, secondId);
  if (firstId === secondId || first.x === second.x && first.y === second.y) return session.edits;
  return setRetailPositions(session, actors, new Map([[firstId, { x: second.x, y: second.y }], [secondId, { x: first.x, y: first.y }]]));
}

interface Position { x: number; y: number }

function setAuthoredPositions(project: AuthoredProject, selected: number, targets: Map<number, Position>): AuthoredProject {
  if (!Number.isInteger(selected) || !project.rows[selected]) throw new Error('Select a dialogue line before editing positions.');
  for (const [id, position] of targets) {
    if (!project.actors.some(actor => actor.id === id)) throw new Error('The portrait must belong to this skit.');
    if (![position.x, position.y].every(Number.isSafeInteger)) throw new Error('Portrait positions must be whole numbers.');
    if (![position.x, position.y].every(value => value >= -32768 && value <= 32767)) {
      throw new Error('Portrait positions exceed the supported staging range.');
    }
  }
  const row = project.rows[selected];
  // The authored format permits one event per actor per row and shares one
  // duration between XY and scale. Do not silently turn timed scaling into
  // an immediate change or create a second event that the compiler rejects.
  if (row.stage.some(event => targets.has(event.actorId) && event.scalePercent !== undefined && (event.movementTicks ?? 0) > 0)) {
    throw new Error('This portrait has a timed scale change on the selected line. Edit its stage event to change position.');
  }
  const staged = new Set<number>();
  const stage = row.stage.map(event => {
    const target = targets.get(event.actorId);
    if (!target) return event;
    staged.add(event.actorId);
    return { ...event, ...target, movementTicks: 0 };
  });
  for (const [actorId, target] of targets) {
    if (!staged.has(actorId)) stage.push({ actorId, ...target, movementTicks: 0 });
  }
  if (JSON.stringify(stage) === JSON.stringify(row.stage)) return project;
  return { ...project, rows: project.rows.map((item, index) => index === selected ? { ...item, stage } : item) };
}

/** Set this row's position while preserving appearance, fades and scale timing. */
export function setAuthoredPosition(project: AuthoredProject, selected: number, actorId: number, x: number, y: number): AuthoredProject {
  return setAuthoredPositions(project, selected, new Map([[actorId, { x, y }]]));
}

/** Replace the selected row's XY movement with an immediate position exchange. */
export function swapAuthoredPositions(project: AuthoredProject, selected: number, actors: StageActor[], firstId: number, secondId: number): AuthoredProject {
  const [first, second] = pair(actors, firstId, secondId);
  if (!Number.isInteger(selected) || !project.rows[selected]) throw new Error('Select a dialogue line before swapping positions.');
  if (![firstId, secondId].every(id => project.actors.some(actor => actor.id === id))) {
    throw new Error('Both portraits must belong to this skit.');
  }
  const a = { x: Math.round(first.x), y: Math.round(first.y) }, b = { x: Math.round(second.x), y: Math.round(second.y) };
  if (firstId === secondId || a.x === b.x && a.y === b.y) return project;
  return setAuthoredPositions(project, selected, new Map([[firstId, b], [secondId, a]]));
}
