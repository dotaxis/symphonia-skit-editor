import { actorName } from './characters';
import { constantArguments } from './constant-arguments';
import { insertedInstruction, PreviewValues } from './preview-values';
import { effectiveInstructions } from './model';
import type { StageActor } from './Stage';
import type { Argument, DialogueLine, Session } from './types';

export interface RetailStageActor extends StageActor { xArgument?: Argument; yArgument?: Argument; spawnPc?: number }
export interface RetailStage { actors: RetailStageActor[]; warning?: string }

interface Event { pc: number; opcode: number; args: Argument[]; order: number }
interface Trace { events: Event[]; warnings: Set<string>; complete: boolean }
interface Cue { voice: number; position: number; delayStep?: number }
interface Change extends Cue { event: Event; stream: number }
interface RowCue extends Cue { eventOrder: number; overlayOrder: number }
const RESOURCE_BASE = 0xd0000;
const slot = (value: number | undefined) => value !== undefined && Number.isInteger(value)
  && value >= 0 && value < 222 ? value : undefined;
const resource = (value: number | undefined) => value === undefined ? undefined : slot(value - RESOURCE_BASE);
const animation = (value: number | undefined) => resource(value) ?? slot(value);
const frames = (value: number | undefined) => value === undefined || value < 0 || value === 255 ? -1 : value;
const before = (a: Cue, b: Cue) => a.voice < b.voice || a.voice === b.voice && a.position <= b.position;
const stageOpcode = (opcode: number) => [0x12, 0x16, 0x57, 0x1d, 0x5e].includes(opcode);

function relevant(event: Event): boolean {
  if (event.opcode === 0x1d) {
    const property = event.args[1]?.value;
    // Computed rotation in retail shake loops does not change the expression.
    return property === undefined || [1, 2, 63, 64, 65].includes(property)
      || property === 37 && event.args[2]?.value !== undefined;
  }
  if (event.opcode === 0x64) return event.args[0]?.value === undefined || [0, 15, 17].includes(event.args[0].value);
  return [0x0c, 0x12, 0x16, 0x39, 0x56, 0x57, 0x59, 0x5e, 0xf1, 0xf4].includes(event.opcode);
}

/** Decode only the directly known arguments in saved-project insertions. */
function insertedEvents(session: Session, warnings: Set<string>): Map<number, Event[]> {
  const result = new Map<number, Event[]>();
  for (const insertion of session.edits.insertions ?? []) {
    const values: Argument[] = [], args: Argument[] = [];
    let popped: Argument = { editable: false };
    const events = result.get(insertion.beforePc) ?? [];
    for (const raw of insertion.instructions) {
      const op = raw as { kind: string; value?: number; opcode?: number };
      if (op.kind === 'literal') values.push({ value: op.value, editable: false });
      else if (op.kind === 'loadGlobal') values.push({ editable: false });
      else if (op.kind === 'calculate' && op.opcode === 0) popped = values.pop() ?? { editable: false };
      else if (op.kind === 'calculate') { values.length = 0; values.push({ editable: false }); }
      else if (op.kind === 'argument') { args.push(popped); popped = { editable: false }; }
      else if (op.kind === 'native' && op.opcode !== undefined) {
        const event = { pc: insertion.beforePc, opcode: op.opcode, args: args.splice(0), order: 0 };
        if (relevant(event)) events.push(event);
        values.length = 0;
      } else {
        warnings.add('Inserted control flow cannot be reconstructed in this preview.');
        events.push({ pc: insertion.beforePc, opcode: -1, args: [], order: 0 });
        break;
      }
    }
    result.set(insertion.beforePc, events);
  }
  return result;
}

/**
 * Follow executable paths, merging branches only when their next meaningful
 * event is the same. This skips irrelevant finite/looping shake code without
 * selecting an arbitrary branch that could change a portrait or voice.
 */
function convergedTrace(session: Session, root: number): Trace {
  const warnings = new Set<string>();
  const inserted = insertedEvents(session, warnings);
  const deleted = (session.edits as Session['edits'] & { deletions?: { startPc: number; endPc: number }[] }).deletions ?? [];
  const entries = new Set(session.document.entries.map(entry => entry.pc));
  entries.add(session.document.defaultPc);
  const instructions = constantArguments(effectiveInstructions(session)
    .filter(op => !deleted.some(range => op.pc >= range.startPc && op.pc < range.endPc)), entries,
    new Map(session.edits.literals.map(edit => [edit.pc, edit.value])));
  const byPc = new Map(instructions.map((op, i) => [op.pc, i]));
  const groups = new Map<number, Event[]>();
  for (const op of instructions) {
    const events = [...(inserted.get(op.pc) ?? [])];
    if (op.nativeOpcode !== undefined) {
      const event = { pc: op.pc, opcode: op.nativeOpcode, args: op.arguments ?? [], order: 0 };
      if (relevant(event)) events.push(event);
    }
    if (events.length) groups.set(op.pc, events);
  }
  const events: Event[] = [];
  const visited = new Set<number>();
  let cursor = byPc.get(root), complete = true;
  while (cursor !== undefined && cursor < instructions.length) {
    const soft = (index: number) => groups.get(instructions[index]?.pc)?.every(event => event.opcode === 0x64
      && event.args[0]?.value === 0 && event.args[1]?.value !== undefined);
    let candidates = new Set<number>(), ended = false, uncertain = false;
    // Keep fixed waits as row boundaries on a straight path. Inside an
    // otherwise irrelevant branch/loop they must not prevent reconvergence.
    for (const ignoreSoft of [false, true]) {
      const pending = [cursor], scanned = new Set<number>();
      candidates = new Set(); ended = false; uncertain = false;
      let branched = false;
      while (pending.length) {
        const index = pending.pop()!;
        if (scanned.has(index)) continue;
        scanned.add(index);
        const op = instructions[index];
        if (!op || op.pc !== root && entries.has(op.pc)) { ended = true; continue; }
        if (groups.has(op.pc) && !(ignoreSoft && soft(index))) { candidates.add(index); continue; }
        if (op.nativeOpcode === 0x1d && op.arguments?.[1]?.value === 37) {
          warnings.add('Animated rotation is approximated at dialogue cues.');
        }
        if ([0x20ff, 0x2003].includes(op.word)) { ended = true; continue; }
        if (op.word === 0x2002) { uncertain = true; continue; }
        if (op.word === 0x2001 || op.word === 0x2004) {
          branched ||= op.word === 0x2004;
          const target = op.targetPc === undefined ? undefined : byPc.get(op.targetPc);
          if (target === undefined) uncertain = true;
          else pending.push(target);
          if (op.word === 0x2001) continue;
        }
        pending.push(index + 1);
      }
      if (ignoreSoft || !branched || ![...candidates].some(soft)) break;
    }
    if (uncertain || candidates.size > 1 || ended && candidates.size > 0) {
      warnings.add('A branch or subroutine prevents reconstructing later portrait changes.');
      complete = false; break;
    }
    if (!candidates.size) break;
    const next = [...candidates][0], op = instructions[next];
    if (visited.has(op.pc)) {
      warnings.add('A repeating script path prevents reconstructing later portrait changes.');
      complete = false; break;
    }
    visited.add(op.pc);
    for (const event of groups.get(op.pc)!) {
      if (event.opcode === -1) return { events, warnings, complete: false };
      if ([0x56, 0x59].includes(event.opcode) && event.args[0]?.value === undefined
        || event.opcode === 0x64 && (event.args[0]?.value === undefined
          || [0, 17].includes(event.args[0].value) && event.args[1]?.value === undefined)) {
        warnings.add('A computed voice or wait prevents synchronizing later portrait changes.');
        complete = false;
        return { events, warnings, complete };
      }
      events.push({ ...event, order: events.length });
    }
    // A semantic event can be an insertion at a jump/end boundary.
    if ([0x20ff, 0x2003].includes(op.word)) break;
    if (op.word === 0x2001) cursor = op.targetPc === undefined ? undefined : byPc.get(op.targetPc);
    else if ([0x2002, 0x2004].includes(op.word)) {
      warnings.add('Inserted changes at a control-flow boundary cannot be reconstructed.');
      complete = false; break;
    } else cursor = next + 1;
  }
  return { events, warnings, complete };
}

/** Execute known scalar/control flow, including finite staging loops. If a
 * condition depends on game state, retain the conservative branch merge rather
 * than choosing an arbitrary outcome. Neither path runs native game code. */
export function traceRetailContext(session: Session, root: number): Trace {
  const warnings = new Set<string>(), events: Event[] = [];
  const inserted = new Map<number, object[]>();
  for (const insertion of session.edits.insertions ?? []) {
    inserted.set(insertion.beforePc, [...inserted.get(insertion.beforePc) ?? [], ...insertion.instructions]);
  }
  // Keep deleted PCs as boundaries: a replacement argument can be inserted at
  // the beginning of the exact span it deletes (scoped portrait replacement).
  const instructions = effectiveInstructions(session);
  const byPc = new Map(instructions.map((op, i) => [op.pc, i]));
  const entries = new Set([session.document.defaultPc, ...session.document.entries.map(entry => entry.pc)]);
  const values = new PreviewValues(new Map(session.edits.literals.map(edit => [edit.pc, edit.value])));
  let cursor = byPc.get(root), steps = 0;
  const fallback = (pc: number, beforeInsertions: number): Trace => {
    const remaining = convergedTrace(session, pc);
    return { events: [...events.slice(0, beforeInsertions), ...remaining.events].map((event, order) => ({ ...event, order })),
      warnings: new Set([...warnings, ...remaining.warnings]), complete: remaining.complete };
  };
  while (cursor !== undefined && cursor < instructions.length) {
    const op = instructions[cursor];
    if (op.pc !== root && entries.has(op.pc)) break;
    if (++steps > 100_000 || events.length > 10_000) {
      warnings.add('A repeating script path exceeds the preview trace limit.');
      return { events, warnings, complete: false };
    }
    const beforeInsertions = events.length, pending: Event[] = [];
    const evaluate = (instruction: typeof op) => {
      const args = values.step(instruction);
      if (instruction.nativeOpcode === undefined) return;
      const event = { pc: op.pc, opcode: instruction.nativeOpcode, args: args ?? [], order: 0 };
      if (relevant(event)) pending.push(event);
      else if (instruction.nativeOpcode === 0x1d && args?.[1]?.value === 37) warnings.add('Animated rotation is approximated at dialogue cues.');
    };
    const deleted = session.edits.deletions?.some(range => op.pc >= range.startPc && op.pc < range.endPc);
    try {
      for (const raw of inserted.get(op.pc) ?? []) evaluate(insertedInstruction(raw));
      if (!deleted) evaluate(op);
    }
    catch (error) {
      warnings.add(error instanceof Error ? error.message : String(error));
      return { events, warnings, complete: false };
    }
    for (const event of pending) {
      if (event.opcode === -1) return { events, warnings, complete: false };
      if ([0x56, 0x59].includes(event.opcode) && event.args[0]?.value === undefined
        || event.opcode === 0x64 && (event.args[0]?.value === undefined
          || [0, 17].includes(event.args[0].value) && event.args[1]?.value === undefined)) {
        warnings.add('A computed voice or wait prevents synchronizing later portrait changes.');
        return { events, warnings, complete: false };
      }
      events.push({ ...event, order: events.length });
    }
    if (deleted) { cursor++; continue; }
    if ([0x20ff, 0x2003].includes(op.word)) break;
    if (op.word === 0x2002 || op.word === 0x2004 && values.condition === undefined) return fallback(op.pc, beforeInsertions);
    if (op.word === 0x2001 || op.word === 0x2004 && values.condition === 0) {
      const target = op.targetPc === undefined ? undefined : byPc.get(op.targetPc);
      if (target === undefined) {
        warnings.add('A branch targets invalid code; later portrait changes cannot be reconstructed.');
        return { events, warnings, complete: false };
      }
      cursor = target;
    } else cursor++;
  }
  return { events, warnings, complete: true };
}

function apply(actors: Map<number, RetailStageActor>, event: Event, warnings: Set<string>, laterCue = true) {
  const args = event.args, id = args[0]?.value;
  if (!stageOpcode(event.opcode)) return;
  if (id === undefined) { warnings.add('A computed actor cannot be reconstructed in this preview.'); return; }
  if (event.opcode === 0x12) {
    if (id === -1 || id === 99999) {
      // The engine has special actor selectors; do not guess which one a file uses.
      warnings.add('A special actor selector cannot be reconstructed in this preview.');
    } else actors.delete(id);
    return;
  }
  if (event.opcode === 0x57) {
    const previous = actors.get(id), texture = resource(args[12]?.value);
    if (texture === undefined) warnings.add('A computed portrait resource is shown as a placeholder.');
    const x = args[2]?.value ?? previous?.x ?? 320, y = args[3]?.value ?? previous?.y ?? 200;
    if (args[2]?.value === undefined || args[3]?.value === undefined) warnings.add('Computed portrait positions are approximated.');
    actors.set(id, {
      id, name: actorName(id, texture), slot: texture ?? -1, animationSlot: texture, spawnPc: event.pc,
      x, y, xArgument: args[2], yArgument: args[3],
      scale: 1, rotation: args[6]?.value ?? 0, alpha: args[10]?.value ?? 255,
      eyeFrame: -1, mouthFrame: -1, visible: true,
    });
    return;
  }
  const actor = actors.get(id);
  if (!actor) return;
  if (event.opcode === 0x16) {
    // Audio milestones are not established seconds. Preserve the start position
    // at the launch cue and use the destination at subsequent cues. In
    // particular, actors moved offstage must not remain at their last spawn.
    if (args[1]?.value === undefined || args[2]?.value === undefined || args[4]?.value === undefined) {
      warnings.add('A computed movement cannot be reconstructed in this preview.');
      return;
    }
    if (args[4].value === 0) return;
    warnings.add('Movement uses its start position at the launch cue and destination at later cues; motion is not replayed.');
    if (laterCue) {
      actor.x = args[1].value; actor.y = args[2].value;
      actor.xArgument = args[1]; actor.yArgument = args[2];
    }
    return;
  }
  if (event.opcode === 0x5e) {
    if (args[1]?.value !== undefined) actor.scale = Math.max(0, args[1].value) / 100;
    else warnings.add('Computed portrait scale is approximated.');
    return;
  }
  const property = args[1]?.value, value = args[2]?.value;
  if (property === undefined || value === undefined) {
    if (property === 63) actor.animationSlot = -1;
    if (property === 64) actor.eyeFrame = -1;
    if (property === 65) actor.mouthFrame = -1;
    warnings.add('A computed portrait property is approximated.'); return;
  }
  if (property === 1) { actor.x = value; actor.xArgument = args[2]; }
  else if (property === 2) { actor.y = value; actor.yArgument = args[2]; }
  else if (property === 37) actor.rotation = value;
  else if (property === 63) {
    actor.animationSlot = animation(value) ?? -1;
    if (actor.animationSlot === -1) warnings.add('An unknown facial-animation resource cannot be reconstructed.');
  } else if (property === 64) actor.eyeFrame = frames(value);
  else if (property === 65) actor.mouthFrame = frames(value);
}

function advance(event: Event, cue: Cue): void {
  if (event.opcode === 0x59) {
    const position = event.args[0]?.value;
    if (position !== undefined) cue.position = position < 0 ? Infinity : Math.max(cue.position, position);
  } else if (event.opcode === 0x64 && event.args[0]?.value === 15) cue.position = Infinity;
}

function snapshot(changes: Change[], cue: RowCue, warnings: Set<string>): RetailStage {
  const actors = new Map<number, RetailStageActor>();
  const applicable = changes.filter(change => before(change, cue)
    && (change.stream === 0 || change.event.order <= cue.overlayOrder));
  applicable.sort((a, b) => a.voice - b.voice || (a.position === b.position ? 0 : a.position - b.position)
    || a.stream - b.stream || a.event.order - b.event.order);
  for (const change of applicable) apply(actors, change.event, warnings,
    change.voice < cue.voice || change.position < cue.position
      || change.stream === 0 && (change.delayStep ?? 0) < (cue.delayStep ?? 0));
  return { actors: [...actors.values()].sort((a, b) => a.id - b.id),
    warning: warnings.size ? [...warnings].join(' ') : undefined };
}

/**
 * Reconstruct the cast at each subtitle cue using the native audio milestones
 * shared by the staging and subtitle contexts. Milestones are compared only;
 * they are never guessed to be seconds. This does not run the game's full VM.
 */
export function retailStages(session: Session, lines: DialogueLine[]): RetailStage[] {
  const subtitleEntry = session.document.entries.find(entry => entry.kind === 2 && entry.id === 3000);
  const main = traceRetailContext(session, session.document.defaultPc);
  const warnings = new Set(main.warnings);
  const changes: Change[] = [], mainRows = new Map<number, RowCue>();
  const voices = new Map<number, number[]>();
  const cue: Cue = { voice: -1, position: 0 };
  let voice = -1;
  for (let i = 0; i < main.events.length; i++) {
    const event = main.events[i];
    if (event.opcode === 0x56 && (event.args[0]?.value ?? 0) > 0) {
      cue.voice = ++voice; cue.position = 0;
      const id = event.args[0].value!;
      voices.set(id, [...(voices.get(id) ?? []), voice]);
    } else if (event.opcode === 0x56 && event.args[0]?.value === -1) cue.position = Infinity;
    advance(event, cue);
    if (event.opcode === 0x64 && event.args[0]?.value === 0 && (event.args[1]?.value ?? 0) > 0) {
      cue.delayStep = (cue.delayStep ?? 0) + 1;
    }
    if (subtitleEntry && event.opcode === 0x64 && event.args[0]?.value === 0 && (event.args[1]?.value ?? 0) > 0 && cue.voice >= 0) {
      cue.position = Infinity;
      warnings.add('Changes after fixed delays are deferred until the next voice cue.');
    }
    if (event.opcode === 0x39 && event.args[0]?.value !== 3000) warnings.add('Additional script contexts are not reconstructed.');
    if (stageOpcode(event.opcode)) changes.push({ ...cue, event, stream: 0 });
    if (event.opcode === 0xf4) {
      // A reopened sequential file keeps staging and subtitles in one stream.
      const rowCue: RowCue = { ...cue, eventOrder: event.order, overlayOrder: -1 };
      let j = i + 1;
      for (; j < main.events.length; j++) {
        const next = main.events[j];
        if ([0xf4, 0x56, 0x59, 0x64].includes(next.opcode)) break;
        rowCue.eventOrder = next.order;
      }
      mainRows.set(event.pc, rowCue);
    }
  }
  const subtitleRows = new Map<number, RowCue>();
  const unmatched = new Set<number>();
  if (subtitleEntry) {
    const subtitles = traceRetailContext(session, subtitleEntry.pc);
    for (const warning of subtitles.warnings) warnings.add(warning);
    const current: Cue = { voice: -1, position: 0 };
    let synchronized = false;
    for (let i = 0; i < subtitles.events.length; i++) {
      const event = subtitles.events[i];
      if (event.opcode === 0x64 && event.args[0]?.value === 17) {
        const matching = voices.get(event.args[1]?.value ?? -1) ?? [];
        synchronized = matching.length === 1;
        if (synchronized) { current.voice = matching[0]; current.position = 0; }
      }
      advance(event, current);
      if (event.opcode === 0x64 && event.args[0]?.value === 0 && (event.args[1]?.value ?? 0) > 0) {
        synchronized = false;
        warnings.add('A fixed subtitle delay cannot be matched to a native audio milestone.');
      }
      if (stageOpcode(event.opcode) && synchronized) changes.push({ ...current, event, stream: 1 });
      if (event.opcode !== 0xf4) continue;
      if (!synchronized) { unmatched.add(event.pc); continue; }
      const rowCue: RowCue = { ...current, eventOrder: Infinity, overlayOrder: event.order };
      for (let j = i + 1; j < subtitles.events.length; j++) {
        const next = subtitles.events[j];
        if ([0xf4, 0x56, 0x59, 0x64].includes(next.opcode)) break;
        rowCue.overlayOrder = next.order;
      }
      subtitleRows.set(event.pc, rowCue);
    }
  }
  // With no synchronized cue, show only initialization, never a future cast.
  const initial: RowCue = { voice: -1, position: Infinity, eventOrder: Infinity, overlayOrder: -1 };
  const firstCue = main.events.find(event => [0x0c, 0xf4].includes(event.opcode)
    || event.opcode === 0x56 && (event.args[0]?.value ?? 0) > 0)?.order ?? Infinity;
  return lines.map(line => {
    const rowWarnings = new Set(warnings);
    const pc = line.instructionPc;
    const own = pc === undefined ? undefined : mainRows.get(pc);
    const rowCue = own ?? (pc === undefined || line.voiceAmbiguous ? undefined : subtitleRows.get(pc));
    if (!rowCue) rowWarnings.add(line.voiceAmbiguous || unmatched.has(pc ?? -1)
      ? 'This subtitle has no unique voice cue; the preview shows the initial cast.'
      : 'This row could not be synchronized; the preview shows the initial cast.');
    const selected = rowCue ?? initial;
    // In a sequential context, order resolves multiple rows without voices or
    // with fixed waits. Do not let later same-position changes leak backwards.
    const visibleChanges = own ? changes.filter(change => change.stream !== 0 || change.event.order <= own.eventOrder)
      : rowCue ? changes : changes.filter(change => change.stream === 0 && change.event.order < firstCue);
    return snapshot(visibleChanges,
      selected, rowWarnings);
  });
}
