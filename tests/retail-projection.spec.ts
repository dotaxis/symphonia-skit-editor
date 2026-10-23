import { expect, test } from '@playwright/test';
import { dialogueLines } from '../src/model';
import { retailStages } from '../src/retail-projection';
import type { Instruction, Session } from '../src/types';
import { readFileSync } from 'node:fs';
import { loopingPortraitFixture } from './looping-portrait-fixture';

const call = (pc: number, opcode: number, values: (number | undefined)[]): Instruction => ({
  pc, nativeOpcode: opcode, word: 0x2000 | opcode, words: [0x2000 | opcode], mnemonic: 'native',
  arguments: values.map((value, i) => ({ value, editable: value !== undefined, literalPc: pc * 16 + i })),
});
const end = (pc: number): Instruction => ({ pc, word: 0x20ff, words: [0x20ff], mnemonic: 'end' });
const jump = (pc: number, targetPc: number, conditional = false): Instruction => ({ pc,
  word: conditional ? 0x2004 : 0x2001, words: [conditional ? 0x2004 : 0x2001, targetPc],
  mnemonic: conditional ? 'branch_false' : 'jump', targetPc });
const spawn = (pc: number, slot: number, x = 420) => call(pc, 0x57, [6, undefined, x, 120, -1, -1, 0, 255, 255, 255, 255, 0, 0xd0000 + slot]);
const text = (pc: number, message: number) => call(pc, 0xf4, [6, -1, message]);
const speaker = (pc: number) => call(pc, 0xf1, [6, 0xae71b]);
const eyes = (pc: number, value: number) => call(pc, 0x1d, [6, 64, value]);
function session(instructions: Instruction[], subtitlePc?: number): Session {
  return { filename: 'FC_W085.SKP', original: new Uint8Array(), edits: { messages: [], literals: [] }, document: {
    format: 'test', version: 1, byteLength: 0, scenarioOffset: 0, scenarioSize: 0, codeOffset: 0, dataOffset: 0,
    defaultPc: instructions[0]?.pc ?? 0, entries: subtitlePc === undefined ? [] : [{ kind: 2, id: 3000, pc: subtitlePc }],
    instructions, diagnostics: [], codeEditable: true,
    messages: Array.from({ length: 5 }, (_, index) => ({ index, offset: 0, byteLength: 1, editable: true,
      tokens: [{ kind: 'text' as const, text: `Line ${index}` }], text: `Line ${index}` })),
  } };
}
const project = (value: Session) => retailStages(value, dialogueLines(value));

async function compiledSession(spec: object): Promise<Session> {
  const { initSync, create_skit, parse_skit } = await import('../src/wasm/core.js');
  initSync({ module: readFileSync(new URL('../src/wasm/core_bg.wasm', import.meta.url)) });
  const original = create_skit(JSON.stringify(spec));
  return { filename: 'arbitrary-name.SKP', original, document: JSON.parse(parse_skit(original)), edits: { messages: [], literals: [] } };
}

test('finite scale and movement loops retain later portraits and facial overrides for every party member', async () => {
  const cast = [[0, 2], [21, 23], [54, 56], [75, 76], [96, 98], [117, 125], [138, 141], [159, 163], [180, 181]]
    .map(([first, next], index) => ({ id: index + 20, first, next, x: 200, y: 200 }));
  const value = await compiledSession(loopingPortraitFixture(cast));
  const before = JSON.stringify(value);
  for (const filename of ['FC_C000.SKP', 'FC_B006.SKP', 'FC_U000.SKP', 'custom.SKP']) {
    const stages = project({ ...value, filename });
    expect(stages.map(stage => stage.actors.map(actor => [actor.id, actor.slot, actor.eyeFrame])))
      .toEqual([cast.map(actor => [actor.id, actor.first, -1]), cast.map(actor => [actor.id, actor.next, 1]), cast.map(actor => [actor.id, actor.next, -1])]);
    expect(stages.every(stage => !stage.warning?.includes('initial cast') && !stage.warning?.includes('branch'))).toBe(true);
    expect(stages[0].actors[0].scale).toBe(0.9);
  }
  expect(project(value)[0].actors.map(actor => actor.slot)).toEqual(cast.map(actor => actor.first));
  expect(JSON.stringify(value)).toBe(before);
});

test('loop results remain read-only and literal or inserted counter edits change the resolved position', async () => {
  const instructions = [
    { kind: 'loadGlobal', offset: 0x812, width: 's16' }, { kind: 'literal', value: 200 },
    { kind: 'calculate', opcode: 0x10 }, { kind: 'calculate', opcode: 0 },
    { kind: 'label', name: 'loop' }, { kind: 'loadGlobal', offset: 0x812, width: 's16' },
    { kind: 'literal', value: 210 }, { kind: 'calculate', opcode: 0x25 }, { kind: 'calculate', opcode: 0 },
    { kind: 'branchFalse', target: 'done' }, { kind: 'loadGlobal', offset: 0x812, width: 's16' },
    { kind: 'literal', value: 2 }, { kind: 'calculate', opcode: 0x11 }, { kind: 'calculate', opcode: 0 },
    { kind: 'jump', target: 'loop' }, { kind: 'label', name: 'done' },
    ...[6, 0].flatMap(value => [{ kind: 'literal', value }, { kind: 'calculate', opcode: 0 }, { kind: 'argument' }]),
    { kind: 'loadGlobal', offset: 0x812, width: 's16' }, { kind: 'calculate', opcode: 0 }, { kind: 'argument' },
    ...[200, -1, -1, 0, 255, 255, 255, 255, 0, 0xd0000 | 118].flatMap(value => [
      { kind: 'literal', value }, { kind: 'calculate', opcode: 0 }, { kind: 'argument' }]),
    { kind: 'native', opcode: 0x57 },
    ...[6, -1, 0].flatMap(value => [{ kind: 'literal', value }, { kind: 'calculate', opcode: 0 }, { kind: 'argument' }]),
    { kind: 'native', opcode: 0xf4 }, { kind: 'end' },
  ];
  const value = await compiledSession({ instructions, messages: [[{ kind: 'text', text: 'After a finite counter loop.' }]] });
  expect(project(value)[0].actors[0]).toMatchObject({ x: 210, xArgument: { value: 210, editable: false } });
  const bound = value.document.instructions.find(op => op.word === 0x100 && op.words[1] === 210)!;
  value.edits.literals.push({ pc: bound.pc, value: 220 });
  expect(project(value)[0].actors[0]).toMatchObject({ x: 220, xArgument: { value: 220, editable: false } });
  value.edits.deletions = [{ startPc: bound.pc, endPc: bound.pc + bound.words.length }];
  value.edits.insertions = [{ beforePc: bound.pc, instructions: [{ kind: 'literal', value: 230 }] }];
  expect(project(value)[0].actors[0]).toMatchObject({ x: 230, xArgument: { value: 230, editable: false } });
});

test('an endless known loop stops at the preview bound instead of hanging or reaching later portraits', async () => {
  const spec = loopingPortraitFixture();
  const exit = spec.instructions.findIndex(raw => (raw as { kind: string }).kind === 'branchFalse');
  spec.instructions[exit] = { kind: 'jump', target: 'loop' };
  const value = await compiledSession(spec);
  const stages = project(value);
  expect(stages[1].actors.map(actor => actor.slot)).toEqual([0, 54]);
  expect(stages[1].warning).toMatch(/preview trace limit|stack limit/);
});

// Retail movement expressions use signed arithmetic and duration flags, rather
// than direct literal arguments. Keep the raw calculator program in the test.
function computedMove(pc: number, actor: number, left: number, right: number, calculation: number, y: number, ticks = 30): Instruction[] {
  const words = [actor, 0x3000, 0x4000, 0x100, left, 0x100, right, 0x3000 | calculation, 0x3000, 0x4000,
    0x100, y, 0x3000, 0x4000, 0, 0x3000, 0x4000, 0x200, 0, 0x8000, ticks, 0x3037, 0x3000, 0x4000, 0x2016];
  const result: Instruction[] = [];
  for (let i = 0; i < words.length;) {
    const word = words[i], size = word === 0x100 ? 2 : word === 0x200 ? 3 : 1;
    result.push(word === 0x2016 ? call(pc + i, 0x16, [actor, undefined, y, 0, undefined])
      : { pc: pc + i, word, words: words.slice(i, i + size), mnemonic: 'test expression' });
    i += size;
  }
  return result;
}

test('parallel voice milestones order respawns and persistent subtitle frame overrides', () => {
  const value = session([
    spawn(0, 118), call(1, 0x56, [65537]), call(2, 0x59, [165]), call(3, 0x12, [6]), spawn(4, 123, 320), end(5),
    call(10, 0x64, [17, 65537]), text(11, 0), speaker(12), eyes(13, 2),
    call(14, 0x59, [170]), text(15, 1), speaker(16), call(17, 0x59, [547]),
    text(18, 2), speaker(19), eyes(20, 1), end(21),
  ], 10);
  const rows = project(value);
  expect(rows.map(row => row.actors[0].slot)).toEqual([118, 123, 123]);
  expect(rows.map(row => row.actors[0].eyeFrame)).toEqual([2, -1, 1]);
  expect(rows[1].actors[0]).toMatchObject({ x: 320, xArgument: { literalPc: 66 } });
  expect(rows.every(row => !row.warning)).toBe(true);
});

test('sequential files with fixed waits cannot leak the next row portrait or frame backwards', () => {
  for (const voiced of [false, true]) {
    const value = session([spawn(0, 118), ...(voiced ? [call(1, 0x56, [65537])] : []),
      text(2, 0), speaker(3), eyes(4, 2), call(5, 0x64, [0, 180]), call(6, 0x12, [6]), spawn(7, 125),
      ...(voiced ? [call(8, 0x56, [65538])] : []), text(9, 1), speaker(10), eyes(11, 1), call(12, 0x64, [0, 180]), end(13)]);
    const rows = project(value);
    expect(rows.map(row => [row.actors[0].slot, row.actors[0].eyeFrame])).toEqual([[118, 2], [125, 1]]);
    expect(rows.every(row => !row.warning)).toBe(true);
  }
});

test('computed waits and voices stop reconstruction before later expression changes', () => {
  for (const unknown of [call(2, 0x59, [undefined]), call(2, 0x56, [undefined]), call(2, 0x64, [0, undefined])]) {
    const value = session([spawn(0, 118), call(1, 0x56, [65537]), unknown,
      call(3, 0x12, [6]), spawn(4, 125), call(5, 0x56, [65538]), end(6),
      call(10, 0x64, [17, 65537]), text(11, 0), speaker(12), call(13, 0x64, [17, 65538]), text(14, 1), speaker(15), end(16)], 10);
    const rows = project(value);
    expect(rows.map(row => row.actors[0].slot)).toEqual([118, 118]);
    expect(rows[1].warning).toContain('computed voice or wait');
    expect(rows[1].warning).toContain('initial cast');
  }
});

test('property 63 changes animation only, including unknown animation resources', () => {
  const value = session([spawn(0, 118), call(1, 0x1d, [6, 63, 123]), text(2, 0), speaker(3), call(4, 0x64, [0, 30]),
    call(5, 0x1d, [6, 63, undefined]), text(6, 1), speaker(7), end(8)]);
  const rows = project(value);
  expect(rows[0].actors[0]).toMatchObject({ slot: 118, animationSlot: 123 });
  expect(rows[1].actors[0]).toMatchObject({ slot: 118, animationSlot: -1 });
  expect(rows[1].warning).toContain('computed portrait property');
});

test('unsynchronized non-skit rows fall back to initialization before the first text cue', () => {
  const value = session([spawn(0, 118), call(1, 0x0c, [0, 0, 0, 0, 0, 0, 0, 0]),
    call(2, 0x12, [6]), spawn(3, 125), call(4, 0x0c, [0, 0, 0, 0, 0, 0, 0, 1]), end(5)]);
  expect(project(value).map(row => row.actors[0].slot)).toEqual([118, 118]);
});

test('irrelevant shake loops converge, while branches that change portraits stop safely', () => {
  const value = session([spawn(0, 118), call(1, 0x56, [65537]), jump(2, 5), jump(3, 9),
    jump(5, 3, true), call(6, 0x1d, [6, 37, undefined]), call(7, 0x64, [0, 1]), jump(8, 5),
    call(9, 0x64, [15, 1]), call(10, 0x12, [6]), spawn(11, 125), call(12, 0x56, [65538]), end(13),
    call(20, 0x64, [17, 65537]), text(21, 0), speaker(22), call(23, 0x64, [17, 65538]), text(24, 1), speaker(25), end(26)], 20);
  expect(project(value).map(row => row.actors[0].slot)).toEqual([118, 125]);
  value.document.instructions[value.document.instructions.findIndex(op => op.pc === 6)] = spawn(6, 123);
  const stopped = project(value);
  expect(stopped[1].actors[0].slot).toBe(118);
  expect(stopped[1].warning).toContain('branch or subroutine');
});

test('saved literal edits, deletions and row insertions participate without mutating the source', () => {
  const value = session([spawn(0, 118), text(1, 0), speaker(2), call(3, 0x64, [0, 30]),
    call(4, 0x12, [6]), spawn(5, 125), text(6, 1), speaker(7), end(8)]);
  value.edits.literals.push({ pc: 5 * 16 + 12, value: 0xd0000 + 120 });
  value.edits.insertions = [{ beforePc: 3, instructions: [6, 64, 1].flatMap(value => [
    { kind: 'literal', value }, { kind: 'calculate', opcode: 0 }, { kind: 'argument' },
  ]).concat([{ kind: 'native', opcode: 0x1d }, { kind: 'calculate', opcode: 0 }] as never) }];
  const original = JSON.stringify(value);
  expect(project(value).map(row => [row.actors[0].slot, row.actors[0].eyeFrame])).toEqual([[118, 1], [120, -1]]);
  expect(JSON.stringify(value)).toBe(original);
  Object.assign(value.edits, { deletions: [{ startPc: 4, endPc: 6 }] });
  expect(project(value).map(row => [row.actors[0].slot, row.actors[0].eyeFrame])).toEqual([[118, 1], [118, 1]]);
});

test('signed movement targets carry departures across milestones and rewind to the launch positions', () => {
  const other = (pc: number, id: number, slot: number, x: number, y: number) =>
    call(pc, 0x57, [id, undefined, x, y, -1, -1, 0, 255, 255, 255, 255, 0, 0xd0000 + slot]);
  const value = session([
    other(0, 3, 56, 200, 120), other(1, 7, 141, 200, 300), other(2, 8, 163, 420, 300), spawn(3, 117),
    call(4, 0x56, [66368]),
    ...computedMove(20, 3, 200, 500, 0x32, 120), ...computedMove(60, 7, 200, 500, 0x32, 300),
    ...computedMove(100, 8, 420, 500, 0x31, 300), ...computedMove(140, 6, 320, 0, 0x31, 200, 60),
    call(200, 0x59, [165]), call(201, 0x12, [6]), spawn(202, 123, 320), end(203),
    call(300, 0x64, [17, 66368]), text(301, 0), speaker(302), call(303, 0x59, [170]),
    text(304, 1), speaker(305), eyes(306, 1), call(307, 0x59, [547]), text(308, 2), eyes(309, -1), speaker(310), end(311),
  ], 300);
  const original = JSON.stringify(value);
  const rows = project(value);
  expect(rows[0].actors.map(actor => [actor.id, actor.x, actor.y])).toEqual([[3, 200, 120], [6, 420, 120], [7, 200, 300], [8, 420, 300]]);
  for (const row of rows.slice(1)) {
    expect(row.actors.map(actor => [actor.id, actor.x])).toEqual([[3, -300], [6, 320], [7, -300], [8, 920]]);
    expect(row.actors.find(actor => actor.id === 3)?.xArgument).toEqual({ value: -300, editable: false });
    expect(row.actors.find(actor => actor.id === 6)?.spawnPc).toBe(202);
    expect(row.warning).toContain('destination at later cues');
  }
  expect(project(value)[0]).toEqual(rows[0]);
  expect(JSON.stringify(value)).toBe(original);
  value.edits.literals.push({ pc: 23, value: 100 });
  expect(project(value)[1].actors.find(actor => actor.id === 3)?.x).toBe(-400);
});

test('an actor can enter from offscreen, leave, and be destroyed and respawned without retaining the old position', () => {
  const value = session([spawn(0, 118, -300), call(1, 0x56, [65537]),
    call(2, 0x16, [6, 320, 200, 0, -2147483588]), call(3, 0x59, [170]),
    call(4, 0x16, [6, 920, 200, 0, -2147483618]), call(5, 0x59, [300]), call(6, 0x12, [6]),
    call(7, 0x59, [400]), spawn(8, 123, 200), end(9),
    call(20, 0x64, [17, 65537]), text(21, 0), speaker(22), call(23, 0x59, [150]), text(24, 1), speaker(25),
    call(26, 0x59, [250]), text(27, 2), speaker(28), call(29, 0x59, [350]), text(30, 3), speaker(31),
    call(32, 0x59, [450]), text(33, 4), speaker(34), end(35)], 20);
  expect(project(value).map(row => row.actors.map(actor => [actor.x, actor.spawnPc]))).toEqual([
    [[-300, 0]], [[320, 0]], [[920, 0]], [], [[200, 8]],
  ]);
});

test('fixed waits advance sequential movement snapshots while unknown global movement stays unresolved', () => {
  const value = session([spawn(0, 118), call(1, 0x16, [6, -300, 120, 0, -2147483618]),
    text(2, 0), speaker(3), call(4, 0x64, [0, 60]), text(5, 1), speaker(6), end(7)]);
  expect(project(value).map(row => row.actors[0].x)).toEqual([420, -300]);
  value.document.instructions[1] = call(1, 0x16, [6, undefined, 120, 0, -2147483618]);
  expect(project(value).map(row => row.actors[0].x)).toEqual([420, 420]);
  expect(project(value)[1].warning).toContain('computed movement');
});
