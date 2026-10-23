import { expect, test, type Page } from '@playwright/test';

async function initialize(page: Page, extra: object[] = [], indexed = true) {
  await page.goto('/');
  await page.evaluate(async ({ extra, indexed }) => {
    const { core } = await import('/src/core.ts');
    const instructions: object[] = [];
    const ref = (index: number): object[] => indexed
      ? [{ kind: 'loadGlobal', width: 's32', offset: 0x678 }, { kind: 'literal', value: index }, { kind: 'calculate', opcode: 15 }]
      : [{ kind: 'loadGlobal', width: 's32', offset: 0x678 + index * 4 }];
    const arg = (value: number) => [{ kind: 'literal', value }, { kind: 'calculate', opcode: 0 }, { kind: 'argument' }];
    const handle = (index: number) => [...ref(index), { kind: 'calculate', opcode: 0 }, { kind: 'argument' }];
    const call = (opcode: number, args: number[]) => instructions.push(...args.flatMap(arg), { kind: 'native', opcode });
    for (const [index, slot] of [[0, 118], [2, 125]]) instructions.push(...ref(index), ...arg(0xd0000 + slot),
      { kind: 'native', opcode: 0x58 }, { kind: 'calculate', opcode: 16 }, { kind: 'calculate', opcode: 0 },
      ...arg(1), ...handle(index), { kind: 'native', opcode: 0x64 });
    instructions.push(...extra);
    const spawn = (actor: number, slot: number, index: number) => instructions.push(...arg(actor), ...handle(index),
      ...[200, 180, -1, -1, 0, 255, 255, 255, 255, 0, 0xd0000 + slot].flatMap(arg), { kind: 'native', opcode: 0x57 });
    spawn(6, 118, 0); spawn(9, 118, 0);
    call(0xf4, [6, -1, 0]); call(0xf1, [6, 0xae71b]); call(0x64, [0, 180]);
    call(0x12, [6]); spawn(6, 125, 2);
    call(0xf4, [6, -1, 1]); call(0xf1, [6, 0xae71b]); call(0x64, [0, 180]);
    call(0x12, [6]); spawn(6, 118, 0);
    call(0xf4, [6, -1, 2]); call(0xf1, [6, 0xae71b]); call(0x64, [0, 180]);
    instructions.push({ kind: 'end' });
    const original = await core('create_skit', JSON.stringify({ instructions, messages: ['First', 'Second', 'Third'].map(text => [{ kind: 'text', text }]) })) as Uint8Array;
    const document = await core('parse_skit', original) as import('../src/types').SkitDocument;
    (window as unknown as { portraitSession: import('../src/types').Session }).portraitSession = {
      filename: 'FC_W085.SKP', original, document, edits: { messages: [], literals: [] },
    };
  }, { extra, indexed });
}

test('one appearance changes both texture handle and animation while shared loaders and respawns stay unchanged', async ({ page }) => {
  await initialize(page);
  const result = await page.evaluate(async () => {
    const { core } = await import('/src/core.ts');
    const { replacePortraitAppearance, retailPortraitAppearance, retailPortraitResources } = await import('/src/retail-portraits.ts');
    const session = (window as unknown as { portraitSession: import('../src/types').Session }).portraitSession;
    const selected = session.document.instructions.find(op => op.nativeOpcode === 0x57)!;
    const edits = replacePortraitAppearance(session, selected.pc, 120);
    const changed = await core('parse_skit', await core('compile_skit', session.original, JSON.stringify(edits)) as Uint8Array) as import('../src/types').SkitDocument;
    const refs = (document: import('../src/types').SkitDocument) => document.instructions.filter(op => op.nativeOpcode === 0x57).map(op => {
      const start = document.instructions.findIndex(item => item.pc === op.arguments![0].literalPc);
      return { slot: op.arguments![12].value! - 0xd0000, handle: document.instructions.slice(start + 3, start + 6).map(item => item.words) };
    });
    return { before: refs(session.document), after: refs(changed),
      loaders: changed.instructions.filter(op => op.nativeOpcode === 0x58).map(op => op.arguments![0].value! - 0xd0000),
      messages: changed.messages.map(message => message.text), codeEditable: changed.codeEditable,
      status: retailPortraitAppearance({ ...session, edits }, selected.pc),
      groups: retailPortraitResources({ ...session, edits }).map(group => ({ slot: group.slot, count: group.spawnCount, editable: group.editable })),
    };
  });
  expect(result.after.map(item => item.slot)).toEqual([120, 118, 125, 118]);
  expect(result.after[0].handle).not.toEqual(result.before[0].handle);
  expect(result.after.slice(1)).toEqual(result.before.slice(1));
  expect(result.loaders).toEqual([120, 118, 125]);
  expect(result.messages).toEqual(['First', 'Second', 'Third']);
  expect(result.codeEditable).toBe(true);
  expect(result.status).toMatchObject({ currentSlot: 120, editable: true, allEditable: true });
  expect(result.groups).toEqual([{ slot: 118, count: 2, editable: true }, { slot: 125, count: 1, editable: true }]);
});

test('project reopening and repeated local changes reuse the private loader without consuming more handles', async ({ page }) => {
  await initialize(page);
  const result = await page.evaluate(async () => {
    const { core } = await import('/src/core.ts');
    const { readProject } = await import('/src/project.ts');
    const { replacePortraitAppearance, replacePortraitInstances } = await import('/src/retail-portraits.ts');
    let session = (window as unknown as { portraitSession: import('../src/types').Session }).portraitSession;
    const selected = session.document.instructions.find(op => op.nativeOpcode === 0x57)!;
    session = { ...session, edits: replacePortraitAppearance(session, selected.pc, 120) };
    const saved = readProject({ format: 'tos-skit-project', version: 1, kind: 'retail', filename: session.filename,
      original: btoa(String.fromCharCode(...session.original)), edits: session.edits });
    if (saved.kind !== 'retail') throw new Error('Expected retail project');
    session = { ...session, edits: saved.edits };
    for (const slot of [121, 125, 123, 118, 120]) session = { ...session, edits: replacePortraitAppearance(session, selected.pc, slot) };
    session = { ...session, edits: replacePortraitInstances(session, selected.pc, 122) };
    const changed = await core('parse_skit', await core('compile_skit', session.original, JSON.stringify(session.edits)) as Uint8Array) as import('../src/types').SkitDocument;
    return { slots: changed.instructions.filter(op => op.nativeOpcode === 0x57).map(op => op.arguments![12].value! - 0xd0000),
      loads: changed.instructions.filter(op => op.nativeOpcode === 0x58).map(op => op.arguments![0].value! - 0xd0000),
      deletions: session.edits.deletions?.length };
  });
  expect(result.slots).toEqual([122, 118, 125, 118]);
  expect(result.loads).toEqual([122, 118, 125]);
  expect(result.deletions).toBe(1);
});

test('all instances updates local aliases of an existing loader and preserves unrelated expressions', async ({ page }) => {
  await initialize(page, [], false);
  const result = await page.evaluate(async () => {
    const { core } = await import('/src/core.ts');
    const { replacePortraitAppearance, replacePortraitInstances, replacePortraitResource } = await import('/src/retail-portraits.ts');
    let session = (window as unknown as { portraitSession: import('../src/types').Session }).portraitSession;
    const selected = session.document.instructions.find(op => op.nativeOpcode === 0x57)!;
    session = { ...session, edits: replacePortraitAppearance(session, selected.pc, 125) };
    const results = [];
    for (const edits of [replacePortraitInstances(session, selected.pc, 120), replacePortraitResource(session, 125, 120)]) {
      const changed = await core('parse_skit', await core('compile_skit', session.original, JSON.stringify(edits)) as Uint8Array) as import('../src/types').SkitDocument;
      results.push({ slots: changed.instructions.filter(op => op.nativeOpcode === 0x57).map(op => op.arguments![12].value! - 0xd0000),
        loads: changed.instructions.filter(op => op.nativeOpcode === 0x58).map(op => op.arguments![0].value! - 0xd0000) });
    }
    return results;
  });
  expect(result).toEqual(Array(2).fill({ slots: [120, 118, 120, 118], loads: [118, 120] }));
});

test('computed array indices and reassigned handles cannot receive unsafe local resource edits', async ({ page }) => {
  for (const extra of [
    // A dynamic index can alias the apparent free element of the handle array.
    [{ kind: 'loadGlobal', offset: 0x678, width: 's32' }, { kind: 'native', opcode: 0x65 },
      { kind: 'calculate', opcode: 15 }, { kind: 'calculate', opcode: 0 }],
    // Overwriting a handle after initialization invalidates its provenance.
    [{ kind: 'loadGlobal', offset: 0x678, width: 's32' }, { kind: 'literal', value: 0 }, { kind: 'calculate', opcode: 15 },
      { kind: 'literal', value: 42 }, { kind: 'calculate', opcode: 16 }, { kind: 'calculate', opcode: 0 }],
  ]) {
    await initialize(page, extra);
    const error = await page.evaluate(async () => {
      const { replacePortraitAppearance } = await import('/src/retail-portraits.ts');
      const session = (window as unknown as { portraitSession: import('../src/types').Session }).portraitSession;
      const selected = session.document.instructions.find(op => op.nativeOpcode === 0x57)!;
      try { replacePortraitAppearance(session, selected.pc, 120); return ''; }
      catch (error) { return (error as Error).message; }
    });
    expect(error).toMatch(/array indices|outside its supported/);
  }
});

test('saved inserted or edited animation-resource setters prevent a partial appearance replacement', async ({ page }) => {
  await initialize(page);
  const errors = await page.evaluate(async () => {
    const { replacePortraitAppearance } = await import('/src/retail-portraits.ts');
    const { updateLiteral } = await import('/src/model.ts');
    const session = (window as unknown as { portraitSession: import('../src/types').Session }).portraitSession;
    const selected = session.document.instructions.find(op => op.nativeOpcode === 0x57)!;
    const args = [6, 63, 118].flatMap(value => [{ kind: 'literal', value }, { kind: 'calculate', opcode: 0 }, { kind: 'argument' }]);
    const cases = [{ ...session, edits: { ...session.edits, insertions: [{ beforePc: selected.pc + 1,
      instructions: [...args, { kind: 'native', opcode: 0x1d }, { kind: 'calculate', opcode: 0 }] }] } }];
    // A saved literal edit can change a setter's meaning without changing its
    // native opcode. Validate the effective property, not the original value.
    const fake = { pc: 65500, word: 0x201d, words: [0x201d], nativeOpcode: 0x1d, mnemonic: 'native', arguments: [
      { value: 6, literalPc: 65490, editable: true }, { value: 64, literalPc: 65491, editable: true },
      { value: 118, literalPc: 65492, editable: true },
    ] };
    cases.push({ ...session, document: { ...session.document, instructions: [...session.document.instructions, fake] },
      edits: updateLiteral(session.edits, fake.arguments[1], 63) });
    return cases.map(value => {
      try { replacePortraitAppearance(value, selected.pc, 120); return ''; }
      catch (error) { return (error as Error).message; }
    });
  });
  expect(errors).toHaveLength(2);
  for (const error of errors) expect(error).toMatch(/animation-resource commands/);
});
