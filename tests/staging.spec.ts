import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { setAuthoredPosition, setRetailPosition, swapAuthoredPositions, swapRetailPositions } from '../src/staging';
import { projectStage } from '../src/projection';
import type { RetailStageActor } from '../src/retail-projection';
import type { AuthoredLine, AuthoredProject, Session, SkitDocument } from '../src/types';

function actor(id: number, x: number, y: number, xPc = id * 10, yPc = id * 10 + 1): RetailStageActor {
  return { id, name: `Actor ${id}`, slot: id, x, y, scale: 1,
    xArgument: { value: x, editable: true, literalPc: xPc },
    yArgument: { value: y, editable: true, literalPc: yPc } };
}
function session(): Session {
  return { filename: 'test.SKP', original: new Uint8Array(), edits: {
    messages: [{ index: 0, tokens: [{ kind: 'text', text: 'Edited text' }] }],
    literals: [{ pc: 10, value: 200 }, { pc: 99, value: 7 }],
    insertions: [{ beforePc: 100, instructions: [{ kind: 'end' }] }],
    deletions: [{ startPc: 101, endPc: 102 }],
  }, document: { format: 'test', version: 1, byteLength: 0, scenarioOffset: 0, scenarioSize: 0,
    codeOffset: 0, dataOffset: 0, defaultPc: 0, entries: [], instructions: [], messages: [],
    diagnostics: [], codeEditable: true } };
}
function row(id: string, stage: AuthoredLine['stage'] = []): AuthoredLine {
  return { id, text: id, speaker: 1, voiceId: null, voiceEnabled: false,
    durationTicks: 120, eyeFrame: -1, mouthFrame: -1, stage };
}
function project(): AuthoredProject {
  return { filename: 'test.SKP', actors: [1, 2, 3].map(id => ({ id, name: `Actor ${id}`,
    textureSlot: id, x: id * 100, y: 200, scalePercent: 100, rotation: 0, alpha: 255 })),
    rows: [row('earlier', [{ actorId: 1, x: 210, y: 120 }, { actorId: 2, x: 430, y: 300 }]),
      row('selected', [{ actorId: 1, x: 310, y: 220, rotation: 30, movementTicks: 120 },
        { actorId: 3, textureSlot: 4, alpha: 200, fadeTicks: 60 }]),
      row('later', [{ actorId: 1, x: 320, y: 200, movementTicks: 60 }])] };
}

test('retail swap prepares all four coordinates atomically and preserves unrelated edits', () => {
  const value = session(), actors = [actor(1, 200, 120), actor(2, 420, 300)];
  const original = JSON.stringify(value), originalActors = JSON.stringify(actors);
  const changed = swapRetailPositions(value, actors, 1, 2);
  expect(changed.literals).toEqual([{ pc: 99, value: 7 }, { pc: 10, value: 420 },
    { pc: 11, value: 300 }, { pc: 20, value: 200 }, { pc: 21, value: 120 }]);
  expect(changed.messages).toBe(value.edits.messages);
  expect(changed.insertions).toBe(value.edits.insertions);
  expect(changed.deletions).toBe(value.edits.deletions);
  expect(JSON.stringify(value)).toBe(original);
  expect(JSON.stringify(actors)).toBe(originalActors);
});

test('retail placement moves to an empty or occupied anchor without moving other actors', () => {
  const value = session(), actors = [actor(1, 200, 120), actor(2, 420, 300)];
  const before = JSON.stringify(value);
  for (const [x, y] of [[200, 300], [420, 300]]) {
    const changed = setRetailPosition(value, actors, 1, x, y);
    expect(changed.literals.find(edit => edit.pc === 11)?.value).toBe(y);
    expect(changed.literals.some(edit => edit.pc === 20 || edit.pc === 21)).toBe(false);
    expect(changed.messages).toBe(value.edits.messages);
  }
  expect(setRetailPosition(value, actors, 1, 200, 120)).toBe(value.edits);
  expect(JSON.stringify(value)).toBe(before);
});

test('a snapped move rejects a computed or shared axis without partially applying the other axis', () => {
  const value = session(), actors = [actor(1, 200, 120), actor(2, 420, 300)];
  const before = JSON.stringify(value);
  actors[0].yArgument = { value: 120, editable: false };
  expect(() => setRetailPosition(value, actors, 1, 420, 300)).toThrow(/computed/);
  actors[0].yArgument = { value: 120, editable: true, literalPc: 21 };
  expect(() => setRetailPosition(value, actors, 1, 420, 200)).toThrow(/share a script value/);
  expect(JSON.stringify(value)).toBe(before);
});

test('retail swaps reject a computed changed axis without applying a partial edit', () => {
  const value = session(), actors = [actor(1, 200, 120), actor(2, 420, 300)];
  actors[1].yArgument = { value: 300, editable: false };
  const original = JSON.stringify(value);
  expect(() => swapRetailPositions(value, actors, 1, 2)).toThrow(/computed/);
  expect(JSON.stringify(value)).toBe(original);
  // An unchanged computed axis does not need a write.
  actors[0].y = actors[1].y;
  expect(swapRetailPositions(value, actors, 1, 2).literals).toEqual([
    { pc: 99, value: 7 }, { pc: 10, value: 420 }, { pc: 20, value: 200 },
  ]);
});

test('retail swaps reject conflicting literals shared by either pair or another portrait', () => {
  const value = session();
  expect(() => swapRetailPositions(value, [actor(1, 200, 200, 10, 10), actor(2, 420, 300)], 1, 2))
    .toThrow(/share a script value/);
  expect(() => swapRetailPositions(value, [actor(1, 200, 120), actor(2, 420, 300), actor(3, 200, 200, 10)], 1, 2))
    .toThrow(/share a script value/);
});

test('authored swaps use visible positions over prior staging and preserve other actors and rows', () => {
  const value = project(), before = JSON.stringify(value);
  const visible = projectStage(value, 1, 0.51);
  expect(visible[0].x).toBeCloseTo(235.5);
  const changed = swapAuthoredPositions(value, 1, visible, 1, 2);
  expect(changed.actors).toBe(value.actors);
  expect(changed.rows[0]).toBe(value.rows[0]);
  expect(changed.rows[2]).toBe(value.rows[2]);
  expect(changed.rows[1].stage[1]).toBe(value.rows[1].stage[1]);
  expect(changed.rows[1].stage).toEqual([
    { actorId: 1, x: 430, y: 300, rotation: 30, movementTicks: 0 },
    value.rows[1].stage[1], { actorId: 2, x: 236, y: 146, movementTicks: 0 },
  ]);
  const swapped = projectStage(changed, 1, 0.51);
  expect(swapped[0]).toMatchObject({ x: 430, y: 300, rotation: 30 });
  expect(swapped[0].scale).toBe(visible[0].scale);
  expect(swapped[1]).toMatchObject({ x: 236, y: 146 });
  expect(projectStage(changed, 2, 2)[0]).toMatchObject({ x: 320, y: 200 });
  expect(JSON.stringify(value)).toBe(before);
});

test('authored swaps retain portrait and fade targets and do not accumulate stage events', () => {
  const value = project();
  value.rows[1].stage[0] = { actorId: 1, x: 320, y: 300, textureSlot: 5, alpha: 210,
    visible: true, fadeTicks: 60, movementTicks: 60 };
  const changed = swapAuthoredPositions(value, 1, projectStage(value, 1, 1), 1, 2);
  expect(changed.rows[1].stage[0]).toEqual({ actorId: 1, x: 430, y: 300, textureSlot: 5,
    alpha: 210, visible: true, fadeTicks: 60, movementTicks: 0 });
  for (const time of [0, 0.25, 0.5, 1]) {
    const before = projectStage(value, 1, time)[0], after = projectStage(changed, 1, time)[0];
    expect(after).toMatchObject({ x: 430, y: 300, slot: before.slot, alpha: before.alpha,
      scale: before.scale, visible: before.visible, animationStartSeconds: before.animationStartSeconds });
  }
  const again = swapAuthoredPositions(changed, 1, projectStage(changed, 1, 1), 1, 2);
  expect(again.rows[1].stage).toHaveLength(changed.rows[1].stage.length);
  expect(projectStage(again, 1, 1).slice(0, 2).map(({ x, y }) => [x, y])).toEqual([[320, 300], [430, 300]]);
});

test('numeric position edits after swapping replace the immediate placement without accumulating events', () => {
  const value = project(), swapped = swapAuthoredPositions(value, 1, projectStage(value, 1, 0.5), 1, 2);
  let changed = swapped;
  for (const x of [440, 450, 460]) changed = setAuthoredPosition(changed, 1, 1, x, 300);
  expect(changed.rows[1].stage).toHaveLength(swapped.rows[1].stage.length);
  expect(changed.rows[1].stage[0]).toEqual({ actorId: 1, x: 460, y: 300, rotation: 30, movementTicks: 0 });
  for (const time of [0, 0.5, 1, 2]) {
    expect(projectStage(changed, 1, time)[0]).toMatchObject({ x: 460, y: 300, scale: projectStage(value, 1, time)[0].scale });
  }
  expect(setAuthoredPosition(changed, 1, 1, 460, 300)).toBe(changed);
  expect(() => setAuthoredPosition(changed, 1, 1, 460.1, 300)).toThrow(/whole numbers/);
  expect(() => setAuthoredPosition(changed, 1, 1, 32768, 300)).toThrow(/range/);
});

test('authored swaps and numeric edits reject timed scale changes without mutating the project', () => {
  const value = project();
  value.rows[1].stage[0].scalePercent = 150;
  const original = JSON.stringify(value), visible = projectStage(value, 1, 0.5);
  expect(() => swapAuthoredPositions(value, 1, visible, 1, 2)).toThrow(/timed scale change/);
  expect(() => setAuthoredPosition(value, 1, 1, 450, 300)).toThrow(/timed scale change/);
  expect(JSON.stringify(value)).toBe(original);
  expect(projectStage(value, 1, 0.5)).toEqual(visible);
});

test('authored export retains timed native scale but removes the replaced coordinate movement', async () => {
  const { initSync, author_skit, parse_skit } = await import('../src/wasm/core.js');
  initSync({ module: readFileSync(new URL('../src/wasm/core_bg.wasm', import.meta.url)) });
  const compile = (value: AuthoredProject): SkitDocument => JSON.parse(parse_skit(author_skit(JSON.stringify({
    actors: value.actors.map(({ name, ...actor }) => actor), rows: value.rows.map(({ id, ...line }) => line),
  }))));
  const value = project();
  value.rows[1].stage[1] = { actorId: 3, scalePercent: 120, movementTicks: 60 };
  const changed = swapAuthoredPositions(value, 1, projectStage(value, 1, 0.51), 1, 2);
  const before = compile(value), after = compile(changed);
  const args = (document: SkitDocument, opcode: number) => document.instructions.filter(op => op.nativeOpcode === opcode)
    .map(op => op.arguments!.map(arg => arg.value));
  expect(args(before, 0x5e)).toEqual([[3, 120, 60]]);
  expect(args(after, 0x5e)).toEqual(args(before, 0x5e));
  expect(args(before, 0x16)).toHaveLength(2);
  expect(args(after, 0x16)).toEqual([[1, 320, 200, 0, 0x80000000 | 60]]);
  expect(args(after, 0x1d)).toEqual(expect.arrayContaining([[1, 1, 430], [1, 2, 300], [2, 1, 236], [2, 2, 146]]));
});

test('identical positions are no-ops and invalid participants or rows cannot produce swaps', () => {
  const retail = session(), authored = project(), same = [actor(1, 320, 200), actor(2, 320, 200)];
  expect(swapRetailPositions(retail, same, 1, 2)).toBe(retail.edits);
  expect(swapAuthoredPositions(authored, 1, same, 1, 2)).toBe(authored);
  expect(() => swapRetailPositions(retail, same, 1, 5)).toThrow(/present/);
  expect(() => swapRetailPositions(retail, [actor(1, NaN, 200), same[1]], 1, 2)).toThrow(/known/);
  expect(() => swapAuthoredPositions(authored, -1, same, 1, 2)).toThrow(/Select a dialogue line/);
});
