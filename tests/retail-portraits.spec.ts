import { test, expect } from '@playwright/test';
import { effectiveInstructions, updateLiteral } from '../src/model';
import { replacePortraitResource, retailPortraitResources } from '../src/retail-portraits';
import type { Instruction, Session } from '../src/types';

function call(pc: number, nativeOpcode: number, values: number[]): Instruction {
  return { pc, word: 0x2000 | nativeOpcode, nativeOpcode, mnemonic: 'native', words: [0x2000 | nativeOpcode],
    arguments: values.map((value, index) => ({ value, literalPc: pc * 16 + index, editable: true })) };
}
const load = (pc: number, slot: number) => call(pc, 0x58, [0xd0000 + slot]);
const spawn = (pc: number, slot: number, actor = 1) => call(pc, 0x57, [actor, 0, 200, 200, -1, -1, 0, 255, 255, 255, 255, 20, 0xd0000 + slot]);
function session(instructions: Instruction[]): Session {
  return { filename: 'FC_W001.SKP', original: new Uint8Array(), edits: { messages: [], literals: [] }, document: {
    format: 'test', version: 1, byteLength: 0, scenarioOffset: 0, scenarioSize: 0, codeOffset: 0, dataOffset: 0,
    defaultPc: 0, entries: [], messages: [], instructions, diagnostics: [], codeEditable: true,
  } };
}

test('replacement updates texture loaders and every animation use while preserving other edits', () => {
  const original = session([load(0, 1), load(1, 2), spawn(2, 1), spawn(3, 2), spawn(4, 1, 3),
    call(5, 0x1d, [1, 63, 0xd0001]), call(6, 0x1d, [3, 63, 1]), call(7, 0x59, [100])]);
  original.edits = updateLiteral(original.edits, original.document.instructions[7].arguments?.[0], 300);
  original.edits.messages = [{ index: 0, tokens: [{ kind: 'text', text: 'Edited text.' }] }];
  expect(retailPortraitResources(original)[0]).toEqual({ slot: 1, currentSlot: 1, loadCount: 1, spawnCount: 2,
    actorIds: [1, 3], editable: true, reason: undefined });
  const edits = replacePortraitResource(original, 1, 221);
  const changed = effectiveInstructions({ ...original, edits });
  expect(changed.map(instruction => instruction.arguments?.at(-1)?.value)).toEqual([
    0xd00dd, 0xd0002, 0xd00dd, 0xd0002, 0xd00dd, 0xd00dd, 221, 300,
  ]);
  expect(edits.messages).toEqual(original.edits.messages);
  expect(original.edits.literals).toHaveLength(1);
  expect(changed[2].arguments?.slice(0, 12)).toEqual(original.document.instructions[2].arguments?.slice(0, 12));
});

test('original slot identities remain separate when replacements select the same portrait', () => {
  let value = session([load(0, 1), load(1, 2), spawn(2, 1), spawn(3, 2)]);
  value = { ...value, edits: replacePortraitResource(value, 1, 2) };
  expect(retailPortraitResources(value).map(resource => [resource.slot, resource.currentSlot])).toEqual([[1, 2], [2, 2]]);
  value = { ...value, edits: replacePortraitResource(value, 1, 3) };
  expect(retailPortraitResources(value).map(resource => [resource.slot, resource.currentSlot])).toEqual([[1, 3], [2, 2]]);
});

test('computed resources and unrecognized consumers prevent incomplete replacements', () => {
  const cases = [
    [load(0, 1), spawn(1, 1), { ...load(2, 2), arguments: [{ editable: false }] }],
    [load(0, 1), spawn(1, 1), { ...spawn(2, 2), arguments: spawn(2, 2).arguments!.map((arg, i) => i === 12 ? { editable: false } : arg) }],
    [load(0, 1), spawn(1, 1), call(2, 0x99, [0xd0001])],
    [load(0, 1), spawn(1, 1), { ...call(2, 0x1d, [1, 63, 1]), arguments: [{ value: 1, editable: false }, { editable: false }, { value: 1, editable: false }] }],
  ];
  for (const instructions of cases) {
    const value = session(instructions);
    expect(retailPortraitResources(value).every(resource => !resource.editable)).toBe(true);
    expect(() => replacePortraitResource(value, 1, 3)).toThrow(/cannot be replaced safely/);
  }
});

test('missing loaders, inconsistent references and unresolved code are not editable', () => {
  expect(() => replacePortraitResource(session([spawn(0, 1)]), 1, 2)).toThrow(/no matching resource loader/);
  const inconsistent = session([load(0, 1), spawn(1, 1)]);
  inconsistent.edits = updateLiteral(inconsistent.edits, inconsistent.document.instructions[1].arguments?.[12], 0xd0002);
  expect(() => replacePortraitResource(inconsistent, 1, 3)).toThrow(/inconsistent resource edits/);
  const unresolved = session([load(0, 1), spawn(1, 1)]);
  unresolved.document.codeEditable = false;
  expect(() => replacePortraitResource(unresolved, 1, 2)).toThrow(/unresolved code/);
  for (const slot of [-1, 222, 0.5, NaN, Infinity]) expect(() => replacePortraitResource(unresolved, 1, slot)).toThrow(/0 to 221/);
});

test('frame override insertions remain supported but inserted resource changes are rejected', () => {
  const value = session([load(0, 1), spawn(1, 1)]);
  const args = (values: number[]) => values.flatMap(value => [{ kind: 'literal', value }, { kind: 'calculate', opcode: 0 }, { kind: 'argument' }]);
  value.edits.insertions = [{ beforePc: 1, instructions: [...args([1, 64, 0]), { kind: 'native', opcode: 0x1d }, { kind: 'calculate', opcode: 0 }] }];
  expect(retailPortraitResources(value)[0].editable).toBe(true);
  value.edits.insertions[0].instructions = [...args([1, 63, 1]), { kind: 'native', opcode: 0x1d }];
  expect(() => replacePortraitResource(value, 1, 2)).toThrow(/cannot be replaced safely/);
});

test('compiled replacement preserves the original contexts and every unrelated instruction', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { core } = await import('/src/core.ts');
    const { replacePortraitResource } = await import('/src/retail-portraits.ts');
    const instructions: object[] = [];
    const call = (opcode: number, args: number[]) => {
      instructions.push(...args.flatMap(value => [{ kind: 'literal', value }, { kind: 'calculate', opcode: 0 }, { kind: 'argument' }]), { kind: 'native', opcode });
    };
    call(0x58, [0xd0001]);
    instructions.push({ kind: 'calculate', opcode: 0 });
    call(0x57, [1, 0, 200, 200, -1, -1, 0, 255, 255, 255, 255, 20, 0xd0001]);
    call(0x39, [3000]);
    call(0x56, [0x10001]);
    call(0x59, [-1]);
    instructions.push({ kind: 'end' }, { kind: 'label', name: 'subtitle' });
    call(0x64, [17, 0x10001]); call(0xf4, [1, -1, 0]); call(0xf1, [1, 0xae71b]);
    instructions.push({ kind: 'end' });
    const original = await core('create_skit', JSON.stringify({ instructions, messages: [[{ kind: 'text', text: 'Preserved dialogue.' }]], entries: [{ kind: 2, id: 3000, label: 'subtitle' }] })) as Uint8Array;
    const document = await core('parse_skit', original) as import('../src/types').SkitDocument;
    const edits = replacePortraitResource({ filename: 'FC_W001.SKP', original, document, edits: { messages: [], literals: [] } }, 1, 221);
    const compiled = await core('compile_skit', original, JSON.stringify(edits)) as Uint8Array;
    const changed = await core('parse_skit', compiled) as import('../src/types').SkitDocument;
    const changedPcs = new Set(edits.literals.map(edit => edit.pc));
    const unaffectedWords = (value: import('../src/types').SkitDocument) => value.instructions.filter(instruction => !changedPcs.has(instruction.pc)).map(instruction => instruction.words);
    return { originalEntries: document.entries, changedEntries: changed.entries, originalMessages: document.messages, changedMessages: changed.messages,
      beforeWords: unaffectedWords(document), afterWords: unaffectedWords(changed), resources: changed.instructions.filter(instruction => [0x57, 0x58].includes(instruction.nativeOpcode ?? -1)).map(instruction => instruction.arguments?.at(-1)?.value) };
  });
  expect(result.changedEntries).toEqual(result.originalEntries);
  expect(result.changedMessages).toEqual(result.originalMessages);
  expect(result.afterWords).toEqual(result.beforeWords);
  expect(result.resources).toEqual([0xd00dd, 0xd00dd]);
});
