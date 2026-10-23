import { effectiveInstructions, updateLiteral } from './model';
import type { Argument, EditSet, Session } from './types';

const RESOURCE_BASE = 0xd0000;
const LAST_SLOT = 221;
const isSlot = (value: number | undefined): value is number => value !== undefined && Number.isInteger(value) && value >= 0 && value <= LAST_SLOT;
const resourceSlot = (value: number | undefined) => value !== undefined && isSlot(value - RESOURCE_BASE) ? value - RESOURCE_BASE : undefined;
const animationSlot = (value: number | undefined) => resourceSlot(value) ?? (isSlot(value) ? value : undefined);

export interface RetailPortraitResource {
  /** Stable identity from the original file, even when replacements coincide. */
  slot: number;
  currentSlot: number;
  loadCount: number;
  spawnCount: number;
  actorIds: number[];
  editable: boolean;
  reason?: string;
}
interface Reference { original: Argument; effective: Argument; bareSlot: boolean }
interface Group { resource: RetailPortraitResource; references: Reference[] }

function inspect(session: Session): Group[] {
  const effective = effectiveInstructions(session);
  const appearances = appearanceContext(session);
  const local = appearances.appearances.filter(item => item.local);
  const groups = new Map<number, Group>();
  let globalReason = session.document.codeEditable ? undefined : 'This script has unresolved code and its portrait resources cannot be changed.';
  const unsupported = () => { globalReason ??= 'This script computes or uses portrait resources in a form that cannot be replaced safely.'; };

  for (const [index, original] of session.document.instructions.entries()) {
    // This spawn now owns a separate handle. Its original shared loader still
    // belongs to the resource group, but changing it must not undo a local edit.
    if (original.nativeOpcode === 0x57 && local.some(item => item.spawnPc === original.pc)) continue;
    const args = original.arguments ?? [], current = effective[index].arguments ?? [];
    let argumentIndex: number | undefined, acceptsBareSlot = false;
    if (original.nativeOpcode === 0x58) argumentIndex = 0;
    else if (original.nativeOpcode === 0x57) argumentIndex = 12;
    else if (original.nativeOpcode === 0x1d) {
      if (args[1]?.value === undefined || current[1]?.value === undefined) unsupported();
      if (args[1]?.value === 63 || current[1]?.value === 63) {
        if (args[1]?.value !== 63 || current[1]?.value !== 63) unsupported();
        argumentIndex = 2; acceptsBareSlot = true;
      }
    }

    // A resource handed to an unrecognized native may also keep a texture
    // handle. Do not change just the references whose meaning is established.
    if (args.some((argument, i) => i !== argumentIndex && resourceSlot(argument.value) !== undefined)
      || current.some((argument, i) => i !== argumentIndex && resourceSlot(argument.value) !== undefined)) unsupported();
    if (argumentIndex === undefined) continue;
    const argument = args[argumentIndex], effectiveArgument = current[argumentIndex];
    const slot = acceptsBareSlot ? animationSlot(argument?.value) : resourceSlot(argument?.value);
    const currentSlot = acceptsBareSlot ? animationSlot(effectiveArgument?.value) : resourceSlot(effectiveArgument?.value);
    if (slot === undefined || currentSlot === undefined || !argument?.editable || argument.literalPc === undefined) {
      unsupported(); continue;
    }
    let group = groups.get(slot);
    if (!group) {
      group = { resource: { slot, currentSlot, loadCount: 0, spawnCount: 0, actorIds: [], editable: true }, references: [] };
      groups.set(slot, group);
    }
    if (group.resource.currentSlot !== currentSlot) group.resource.reason = 'This portrait has inconsistent resource edits. Restore its matching texture and animation references before replacing it.';
    group.references.push({ original: argument, effective: effectiveArgument, bareSlot: acceptsBareSlot && isSlot(argument.value) });
    if (original.nativeOpcode === 0x58) group.resource.loadCount++;
    if (original.nativeOpcode === 0x57) group.resource.spawnCount++;
    if (original.nativeOpcode !== 0x58 && current[0]?.value !== undefined && !group.resource.actorIds.includes(current[0].value)) group.resource.actorIds.push(current[0].value);
  }

  // A local appearance may deliberately reuse another original loader. It is
  // part of that loader's current resource group, regardless of its old slot.
  for (const appearance of local) {
    const loader = appearances.loaders.find(item => sameReference(item.reference, appearance.reference));
    if (!loader) continue;
    const originalLoader = session.document.instructions.find(op => op.nativeOpcode === 0x58 && op.pc >= loader.startPc && op.pc < loader.endPc);
    const group = groups.get(resourceSlot(originalLoader?.arguments?.[0]?.value) ?? -1);
    const spawn = session.document.instructions.find(op => op.pc === appearance.spawnPc);
    const effectiveSpawn = effective.find(op => op.pc === appearance.spawnPc);
    if (!group || !spawn?.arguments?.[12] || !effectiveSpawn?.arguments?.[12]) continue;
    group.references.push({ original: spawn.arguments[12], effective: effectiveSpawn.arguments[12], bareSlot: false });
    group.resource.spawnCount++;
    if (!group.resource.actorIds.includes(appearance.actorId)) group.resource.actorIds.push(appearance.actorId);
    if (group.resource.currentSlot !== appearance.currentSlot) group.resource.reason = 'This portrait has inconsistent resource edits. Restore its matching texture and animation references before replacing it.';
  }

  // The original-file identity cannot address resource references introduced
  // by arbitrary saved-project insertions or references removed by deletions.
  const deletions = session.edits.deletions;
  if (deletions?.some(range => !local.some(item => range.startPc === item.handleStart && range.endPc === item.handleEnd))) unsupported();
  for (const insertion of session.edits.insertions ?? []) {
    if (insertion.beforePc === session.document.defaultPc && addedLoader(insertion.beforePc, insertion.instructions)
      || local.some(item => item.handleStart === insertion.beforePc && sameCode(insertion.instructions, handleCode(item.reference)))) continue;
    const args: (number | undefined)[] = []; let pending: number | undefined;
    for (const raw of insertion.instructions) {
      const instruction = raw as { kind: string; value?: number; opcode?: number };
      if (instruction.kind === 'literal') {
        pending = instruction.value;
        if (resourceSlot(instruction.value) !== undefined) unsupported();
      } else if (instruction.kind === 'loadGlobal') pending = undefined;
      else if (instruction.kind === 'argument') { args.push(pending); pending = undefined; }
      else if (instruction.kind === 'calculate' && instruction.opcode !== 0) pending = undefined;
      else if (instruction.kind === 'native') {
        if ([0x57, 0x58].includes(instruction.opcode ?? -1)
          || instruction.opcode === 0x1d && (args[1] === undefined || args[1] === 63)) unsupported();
        args.length = 0; pending = undefined;
      }
    }
  }

  return [...groups.values()].sort((a, b) => a.resource.slot - b.resource.slot).map(group => {
    group.resource.reason = globalReason ?? group.resource.reason
      ?? (group.resource.loadCount ? undefined : 'This portrait has no matching resource loader in the script.');
    group.resource.editable = !group.resource.reason;
    group.resource.actorIds.sort((a, b) => a - b);
    return group;
  });
}

/** All original portrait resources, including expressions used after the first
 * spawn. Replacements preserve the existing loaders, handles and choreography. */
export function retailPortraitResources(session: Session): RetailPortraitResource[] {
  return inspect(session).map(group => group.resource);
}

/** Replace one original resource consistently across every loader and animation
 * reference. The caller passes the original slot identity, not currentSlot. */
export function replacePortraitResource(session: Session, originalSlot: number, newSlot: number): EditSet {
  if (!isSlot(newSlot)) throw new Error('Choose a portrait slot from 0 to 221.');
  const group = inspect(session).find(item => item.resource.slot === originalSlot);
  if (!group) throw new Error('This portrait resource does not occur in the original skit.');
  if (!group.resource.editable) throw new Error(group.resource.reason);
  return group.references.reduce((edits, reference) => updateLiteral(edits, reference.original,
    reference.bareSlot ? newSlot : RESOURCE_BASE + newSlot), session.edits);
}

interface HandleReference { offset: number; index?: number }
interface Loader { slot: number; reference: HandleReference; startPc: number; endPc: number }
interface Appearance {
  spawnPc: number; actorId: number; slot: number; currentSlot: number;
  handleStart: number; handleEnd: number; reference: HandleReference; local: boolean;
}
interface AppearanceContext { appearances: Appearance[]; loaders: Loader[]; added: Loader[]; available?: HandleReference; reason?: string }
export interface RetailPortraitAppearance {
  spawnPc: number; slot: number; currentSlot: number; editable: boolean; reason?: string;
  allEditable: boolean; allReason?: string;
}
const sameReference = (a: HandleReference, b: HandleReference) => a.offset === b.offset && a.index === b.index;
const address = (reference: HandleReference) => reference.offset + (reference.index ?? 0) * 4;
const referenceCode = (reference: HandleReference): object[] => [
  { kind: 'loadGlobal', offset: reference.offset, width: 's32' },
  ...(reference.index === undefined ? [] : [{ kind: 'literal', value: reference.index }, { kind: 'calculate', opcode: 15 }]),
];
const argumentCode = (value: number): object[] => [{ kind: 'literal', value }, { kind: 'calculate', opcode: 0 }, { kind: 'argument' }];
const handleCode = (reference: HandleReference): object[] => [...referenceCode(reference), { kind: 'calculate', opcode: 0 }, { kind: 'argument' }];
const loaderCode = (reference: HandleReference, slot: number): object[] => [
  ...referenceCode(reference), ...argumentCode(RESOURCE_BASE + slot), { kind: 'native', opcode: 0x58 },
  { kind: 'calculate', opcode: 16 }, { kind: 'calculate', opcode: 0 },
  ...argumentCode(1), ...handleCode(reference), { kind: 'native', opcode: 0x64 },
];
const sameCode = (a: object[], b: object[]) => JSON.stringify(a) === JSON.stringify(b);

/** Parse the exact resource-loader form emitted here. No saved-project metadata
 * is trusted: the actual load, assignment and wait instructions must match. */
function addedLoader(beforePc: number, instructions: object[]): Loader | undefined {
  const first = instructions[0] as { kind?: string; width?: string; offset?: number } | undefined;
  if (first?.kind !== 'loadGlobal' || first.width !== 's32' || first.offset === undefined) return;
  const second = instructions[1] as { kind?: string; value?: number } | undefined;
  const third = instructions[2] as { kind?: string; opcode?: number } | undefined;
  const indexed = second?.kind === 'literal' && third?.kind === 'calculate' && third.opcode === 15;
  const reference = { offset: first.offset, ...(indexed ? { index: second.value } : {}) };
  const resource = instructions[indexed ? 3 : 1] as { kind?: string; value?: number } | undefined;
  const slot = resourceSlot(resource?.value);
  if (slot === undefined || !sameCode(instructions, loaderCode(reference, slot))) return;
  return { slot, reference, startPc: beforePc, endPc: beforePc };
}

/** Establish handle provenance from complete instruction patterns rather than
 * assuming that a literal animation slot also selects the texture handle. */
function appearanceContext(session: Session): AppearanceContext {
  const ops = session.document.instructions;
  const effective = effectiveInstructions(session);
  const edits = session.edits;
  const values = new Map(edits.literals.map(edit => [edit.pc, edit.value]));
  const literal = (i: number) => {
    const op = ops[i];
    if (!op || !(op.word <= 255 || [0x100, 0x200, 0x300].includes(op.word))) return;
    if (values.has(op.pc)) return values.get(op.pc)!;
    if (op.word <= 255) return op.word >= 128 ? op.word - 256 : op.word;
    if (op.word === 0x100) return op.words[1] << 16 >> 16;
    if (op.word === 0x300) return op.words[1];
    return op.words[1] | op.words[2] << 16;
  };
  const refAt = (i: number): { reference: HandleReference; next: number } | undefined => {
    if (ops[i]?.word !== 0x1200) return;
    const index = literal(i + 1);
    if (index !== undefined && ops[i + 2]?.word === 0x300f) return { reference: { offset: ops[i].words[1], index }, next: i + 3 };
    return { reference: { offset: ops[i].words[1] }, next: i + 1 };
  };
  const literalArgumentEnd = (i: number) => literal(i) !== undefined && ops[i + 1]?.word === 0x3000 && ops[i + 2]?.word === 0x4000 ? i + 3 : undefined;
  const loaders: Loader[] = [], added: Loader[] = [], appearances: Appearance[] = [];
  let reason = session.document.codeEditable ? undefined : 'This script has unresolved code and its portraits cannot be changed.';
  const fail = (message: string) => { reason ??= message; };
  let initializationEnd = session.document.defaultPc;
  // Resource handles are valid for every context only after this straight-line
  // initialization prefix. Every original loader must belong to that prefix.
  for (let start = ops.findIndex(op => op.pc === session.document.defaultPc); start >= 0 && start < ops.length;) {
    const ref = refAt(start); if (!ref) break;
    const resourceIndex = ref.next, slot = resourceSlot(literal(resourceIndex));
    const afterArgument = literalArgumentEnd(resourceIndex);
    if (slot === undefined || afterArgument === undefined || ops[afterArgument]?.nativeOpcode !== 0x58
      || ops[afterArgument + 1]?.word !== 0x3010 || ops[afterArgument + 2]?.word !== 0x3000
      || literal(afterArgument + 3) !== 1) break;
    const waitValue = literalArgumentEnd(afterArgument + 3);
    const waitRef = waitValue === undefined ? undefined : refAt(waitValue);
    if (!waitRef || !sameReference(ref.reference, waitRef.reference)
      || ops[waitRef.next]?.word !== 0x3000 || ops[waitRef.next + 1]?.word !== 0x4000
      || ops[waitRef.next + 2]?.nativeOpcode !== 0x64) break;
    const next = waitRef.next + 3;
    initializationEnd = ops[next]?.pc ?? ops[waitRef.next + 2].pc + 1;
    loaders.push({ slot, reference: ref.reference, startPc: ops[start].pc, endPc: initializationEnd });
    start = next;
  }
  if (!loaders.length || ops.filter(op => op.nativeOpcode === 0x58).length !== loaders.length) {
    fail('This script does not initialize every portrait handle in a supported straight-line loader block.');
  }
  if (ops.some(op => op.targetPc !== undefined && op.targetPc < initializationEnd)
    || session.document.entries.some(entry => entry.pc < initializationEnd)) {
    fail('This script can enter its resource-loading block more than once.');
  }
  const targets = new Set([...ops.flatMap(op => op.targetPc === undefined ? [] : [op.targetPc]), ...session.document.entries.map(entry => entry.pc)]);
  for (const [i, op] of ops.entries()) {
    if (op.nativeOpcode !== 0x57) continue;
    const args = op.arguments ?? [], current = effective[i].arguments ?? [];
    const slot = resourceSlot(args[12]?.value), currentSlot = resourceSlot(current[12]?.value);
    const start = ops.findIndex(instruction => instruction.pc === args[0]?.literalPc);
    if (start < 0 || slot === undefined || currentSlot === undefined || current[0]?.value === undefined) continue;
    let cursor = start, reference: HandleReference | undefined, handleStart = -1, handleEnd = -1;
    let valid = true;
    for (let arg = 0; arg < 13; arg++) {
      if (arg === 1) {
        const found = refAt(cursor);
        if (!found || ops[found.next]?.word !== 0x3000 || ops[found.next + 1]?.word !== 0x4000) { valid = false; break; }
        reference = found.reference; handleStart = ops[cursor].pc;
        cursor = found.next + 2; handleEnd = ops[cursor]?.pc ?? -1;
      } else {
        if (args[arg]?.literalPc !== ops[cursor]?.pc || !args[arg]?.editable) { valid = false; break; }
        const next = literalArgumentEnd(cursor); if (next === undefined) { valid = false; break; } cursor = next;
      }
    }
    if (!valid || cursor !== i || !reference || [...targets].some(pc => pc > ops[start].pc && pc <= op.pc)) continue;
    const localDeletion = edits.deletions?.some(item => item.startPc === handleStart && item.endPc === handleEnd);
    let local = false;
    if (localDeletion) {
      const inserted = edits.insertions?.filter(item => item.beforePc === handleStart) ?? [];
      if (inserted.length !== 1) continue;
      const first = inserted[0].instructions[0] as { kind?: string; offset?: number; width?: string } | undefined;
      const second = inserted[0].instructions[1] as { kind?: string; value?: number } | undefined;
      if (first?.kind !== 'loadGlobal' || first.width !== 's32' || first.offset === undefined) continue;
      const candidate = { offset: first.offset, ...(second?.kind === 'literal' ? { index: second.value } : {}) };
      if (!sameCode(inserted[0].instructions, handleCode(candidate))) continue;
      reference = candidate; local = true;
    }
    appearances.push({ spawnPc: op.pc, actorId: current[0].value, slot, currentSlot, reference, handleStart, handleEnd, local });
  }
  for (const insertion of edits.insertions ?? []) {
    const loader = insertion.beforePc === session.document.defaultPc ? addedLoader(insertion.beforePc, insertion.instructions) : undefined;
    if (loader) { added.push(loader); continue; }
    if (appearances.some(item => item.local && item.handleStart === insertion.beforePc && sameCode(insertion.instructions, handleCode(item.reference)))) continue;
    if (insertion.instructions.some(raw => {
      const op = raw as { kind?: string; opcode?: number; value?: number };
      return op.kind === 'loadGlobal' || ['jump', 'branchFalse', 'call'].includes(op.kind ?? '')
        || op.kind === 'literal' && resourceSlot(op.value) !== undefined
        || op.kind === 'native' && [0x57, 0x58].includes(op.opcode ?? -1);
    })) fail('Other inserted code prevents safely identifying this portrait’s texture handle.');
    const args: (number | undefined)[] = []; let pending: number | undefined;
    for (const raw of insertion.instructions) {
      const op = raw as { kind: string; value?: number; opcode?: number };
      if (op.kind === 'literal') pending = op.value;
      else if (op.kind === 'argument') { args.push(pending); pending = undefined; }
      else if (op.kind === 'calculate' && op.opcode !== 0) pending = undefined;
      else if (op.kind === 'native') {
        if (op.opcode === 0x1d && (args[1] === undefined || args[1] === 63)) fail('Inserted animation-resource commands prevent changing just this appearance safely.');
        args.length = 0; pending = undefined;
      }
    }
  }
  if (edits.deletions?.some(item => !appearances.some(appearance => appearance.local && item.startPc === appearance.handleStart && item.endPc === appearance.handleEnd))) {
    fail('Other deleted code prevents safely identifying this portrait’s texture handle.');
  }
  const allLoaders = [...loaders, ...added];
  if (allLoaders.some(loader => address(loader.reference) < 0 || address(loader.reference) > 65532)) {
    fail('A portrait handle refers outside the supported global-variable range.');
  }
  if (allLoaders.some((loader, index) => allLoaders.some((other, j) => index !== j && address(loader.reference) === address(other.reference)))) {
    fail('This script reassigns a portrait handle, so its appearances cannot be changed independently.');
  }
  // Reuse only existing, demonstrably unreferenced holes in indexed arrays
  // already used by the script. Never guess a new global or overwrite a handle.
  const occupied: { start: number; end: number }[] = [];
  let computedReference = ops.some((op, i) => op.word === 0x300f
    && !(literal(i - 1) !== undefined && [0x1000, 0x1100, 0x1200].includes(ops[i - 2]?.word)));
  for (const [i, op] of ops.entries()) if ([0x1000, 0x1100, 0x1200].includes(op.word)) {
    const width = op.word === 0x1200 ? 4 : op.word === 0x1100 ? 2 : 1;
    const index = literal(i + 1), indexed = index !== undefined && ops[i + 2]?.word === 0x300f;
    let end = i + (indexed ? 3 : 1);
    for (; end < ops.length && ![0x3000, 0x4000].includes(ops[end].word) && ops[end].nativeOpcode === undefined; end++) {
      if (ops[end].word === 0x300f) computedReference = true;
    }
    const start = op.words[1] + (indexed ? index! * width : 0);
    occupied.push({ start, end: start + width });
    if (allLoaders.some(loader => start < address(loader.reference) + 4 && start + width > address(loader.reference))
      && !loaders.some(loader => loader.startPc === op.pc)
      && ops[i + (indexed ? 3 : 1)]?.word !== 0x3000) {
      fail('This script uses a portrait handle outside its supported loading and read operations.');
    }
  }
  for (const loader of added) occupied.push({ start: address(loader.reference), end: address(loader.reference) + 4 });
  if (computedReference) fail('Computed array indices prevent proving that portrait handles are independent.');
  let available: HandleReference | undefined;
  if (!computedReference && allLoaders.length < 64) {
    for (const loader of loaders) {
      const indexes = loaders.filter(other => other.reference.offset === loader.reference.offset && other.reference.index !== undefined).map(other => other.reference.index!);
      if (indexes.length < 2) continue;
      const min = Math.min(...indexes), max = Math.max(...indexes);
      if (min < 0 || max > 255) continue;
      for (let index = min; index <= max; index++) {
        const candidate = { offset: loader.reference.offset, index }, start = address(candidate);
        if (!occupied.some(range => start < range.end && start + 4 > range.start)) { available = candidate; break; }
      }
      if (available) break;
    }
  }
  return { appearances, loaders, added, available, reason };
}

function appearanceReason(session: Session, context: AppearanceContext, appearance: Appearance | undefined): string | undefined {
  if (context.reason) return context.reason;
  if (!appearance) return 'This portrait’s spawn does not use a supported literal-argument and texture-handle pattern.';
  const matching = [...context.loaders, ...context.added].filter(loader => sameReference(loader.reference, appearance.reference));
  if (matching.length !== 1 || matching[0].slot !== appearance.currentSlot) return 'This portrait’s texture handle and animation resource do not match.';
  if (effectiveInstructions(session).some(op => op.nativeOpcode === 0x1d && (op.arguments?.[0]?.value === appearance.actorId || op.arguments?.[0]?.value === undefined)
    && (op.arguments?.[1]?.value === 63 || op.arguments?.[1]?.value === undefined))) {
    return 'This actor has additional animation-resource commands that prevent changing just this appearance safely.';
  }
}

export function retailPortraitAppearance(session: Session, spawnPc: number): RetailPortraitAppearance {
  const context = appearanceContext(session), appearance = context.appearances.find(item => item.spawnPc === spawnPc);
  let reason = appearanceReason(session, context, appearance);
  if (!reason && !context.available) reason = 'No unused slot was found in the script’s existing portrait-handle arrays. This appearance can only use a portrait already loaded by the skit.';
  const original = session.document.instructions.find(op => op.pc === spawnPc && op.nativeOpcode === 0x57);
  const current = effectiveInstructions(session).find(op => op.pc === spawnPc && op.nativeOpcode === 0x57);
  const slot = resourceSlot(original?.arguments?.[12]?.value) ?? -1;
  const currentSlot = resourceSlot(current?.arguments?.[12]?.value) ?? -1;
  const group = inspect(session).find(item => item.resource.slot === slot);
  const allReason = group?.resource.editable ? undefined : appearanceReason(session, context, appearance);
  return { spawnPc, slot, currentSlot, editable: !appearanceReason(session, context, appearance), reason,
    allEditable: !allReason, allReason };
}

/** Replace a single spawn lifetime. Its shared source loader is never edited. */
export function replacePortraitAppearance(session: Session, spawnPc: number, newSlot: number): EditSet {
  if (!isSlot(newSlot)) throw new Error('Choose a portrait slot from 0 to 221.');
  const context = appearanceContext(session), appearance = context.appearances.find(item => item.spawnPc === spawnPc);
  const reason = appearanceReason(session, context, appearance);
  if (reason || !appearance) throw new Error(reason);
  if (appearance.currentSlot === newSlot) return session.edits;
  const original = session.document.instructions.find(op => op.pc === spawnPc)!;
  let loader = [...context.loaders, ...context.added].find(item => item.slot === newSlot);
  const insertions = [...(session.edits.insertions ?? [])];
  if (!loader) {
    // A private loader introduced for this one appearance can be retargeted
    // without spending another loader slot each time the gallery is used.
    const privateLoader = context.added.find(item => sameReference(item.reference, appearance.reference)
      && context.appearances.filter(other => sameReference(other.reference, item.reference)).length === 1);
    if (privateLoader) return updateLiteral({ ...session.edits, insertions: insertions.map(insertion =>
      insertion.beforePc === session.document.defaultPc && sameCode(insertion.instructions, loaderCode(privateLoader.reference, privateLoader.slot))
        ? { ...insertion, instructions: loaderCode(privateLoader.reference, newSlot) } : insertion),
    }, original.arguments?.[12], RESOURCE_BASE + newSlot);
    const unused = context.added.find(item => !context.appearances.some(other => sameReference(other.reference, item.reference)));
    if (unused) {
      const index = insertions.findIndex(insertion => insertion.beforePc === session.document.defaultPc
        && sameCode(insertion.instructions, loaderCode(unused.reference, unused.slot)));
      insertions[index] = { beforePc: session.document.defaultPc, instructions: loaderCode(unused.reference, newSlot) };
      loader = { ...unused, slot: newSlot };
    } else {
      if (!context.available) throw new Error('No unused slot was found in the script’s existing portrait-handle arrays. Choose a portrait already loaded by this skit, or replace all instances.');
      loader = { slot: newSlot, reference: context.available, startPc: session.document.defaultPc, endPc: session.document.defaultPc };
      insertions.push({ beforePc: session.document.defaultPc, instructions: loaderCode(loader.reference, newSlot) });
    }
  }
  const deletions = [...(session.edits.deletions ?? []).filter(item => item.startPc !== appearance.handleStart || item.endPc !== appearance.handleEnd),
    { startPc: appearance.handleStart, endPc: appearance.handleEnd }];
  const edits = updateLiteral({ ...session.edits, insertions: [
    ...insertions.filter(item => item.beforePc !== appearance.handleStart),
    { beforePc: appearance.handleStart, instructions: handleCode(loader.reference) },
  ], deletions }, original.arguments?.[12], RESOURCE_BASE + newSlot);
  // A previous literal edit to the original array index is superseded by the
  // complete replacement expression and must not remain inside its deletion.
  edits.literals = edits.literals.filter(item => item.pc < appearance.handleStart || item.pc >= appearance.handleEnd);
  return edits;
}

/** Replace every occurrence of the clicked portrait resource, including local
 * replacements saved in this project, without changing other expressions. */
export function replacePortraitInstances(session: Session, spawnPc: number, newSlot: number): EditSet {
  if (!isSlot(newSlot)) throw new Error('Choose a portrait slot from 0 to 221.');
  const selected = effectiveInstructions(session).find(op => op.pc === spawnPc && op.nativeOpcode === 0x57);
  const currentSlot = resourceSlot(selected?.arguments?.[12]?.value);
  if (currentSlot === undefined) throw new Error('This portrait resource could not be identified.');
  if (currentSlot === newSlot) return session.edits;
  let result = session;
  const initialContext = appearanceContext(session);
  const local = initialContext.appearances.filter(item => item.local && item.currentSlot === currentSlot).map(item => item.spawnPc);
  const groups = inspect(session).filter(group => group.resource.currentSlot === currentSlot);
  for (const group of groups) {
    if (!group.resource.editable) throw new Error(group.resource.reason);
    result = { ...result, edits: replacePortraitResource(result, group.resource.slot, newSlot) };
  }
  for (const loader of initialContext.added.filter(item => item.slot === currentSlot)) {
    const appearances = initialContext.appearances.filter(item => item.local && sameReference(item.reference, loader.reference));
    let edits: EditSet = { ...result.edits, insertions: result.edits.insertions?.map(insertion =>
      insertion.beforePc === session.document.defaultPc && sameCode(insertion.instructions, loaderCode(loader.reference, loader.slot))
        ? { ...insertion, instructions: loaderCode(loader.reference, newSlot) } : insertion) };
    for (const appearance of appearances) edits = updateLiteral(edits,
      session.document.instructions.find(op => op.pc === appearance.spawnPc)?.arguments?.[12], RESOURCE_BASE + newSlot);
    result = { ...result, edits };
  }
  for (const pc of local) result = { ...result, edits: replacePortraitAppearance(result, pc, newSlot) };
  if (!groups.length && !local.length) throw new Error('This portrait resource could not be replaced safely.');
  return result.edits;
}
