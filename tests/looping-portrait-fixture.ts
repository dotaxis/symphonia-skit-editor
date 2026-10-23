/** Synthetic versions of retail scale, movement and random shake loops.
 * The same program works with any actor IDs, portrait resources or filename. */
export function loopingPortraitFixture(cast = [
  { id: 1, first: 0, next: 2, x: 200, y: 200 },
  { id: 3, first: 54, next: 56, x: 420, y: 200 },
]) {
  const instructions: object[] = [];
  const literal = (value: number) => [{ kind: 'literal', value }];
  const variable = () => [{ kind: 'loadGlobal', offset: 0x810, width: 's32' }];
  const argument = (expression: object[]) => [...expression, { kind: 'calculate', opcode: 0 }, { kind: 'argument' }];
  const call = (opcode: number, args: (number | object[])[]) => instructions.push(
    ...args.flatMap(value => argument(Array.isArray(value) ? value : literal(value))), { kind: 'native', opcode });
  const spawn = (actor: typeof cast[number], slot: number) => call(0x57,
    [actor.id, 0, actor.x, actor.y, -1, -1, 0, 255, 255, 255, 255, 0, 0xd0000 | slot]);
  for (const actor of cast) spawn(actor, actor.first);
  call(0x39, [3000]); instructions.push({ kind: 'calculate', opcode: 0 });
  call(0x56, [65537]);
  // A locally initialized loop counter makes this branch fully determined.
  instructions.push(...variable(), ...literal(90), { kind: 'calculate', opcode: 0x10 }, { kind: 'calculate', opcode: 0 },
    { kind: 'label', name: 'loop' }, ...variable(), ...literal(110), { kind: 'calculate', opcode: 0x22 },
    { kind: 'calculate', opcode: 0 }, { kind: 'branchFalse', target: 'after-loop' });
  call(0x5e, [cast[0].id, variable(), 1]);
  call(0x16, [cast[0].id, [...literal(cast[0].x), ...variable(), { kind: 'calculate', opcode: 0x31 }], cast[0].y, 0, -2147483647]);
  // The random call must consume its own argument without losing actor/property.
  call(0x1d, [cast[0].id, 37, [...argument(literal(10)), { kind: 'native', opcode: 0x65 }]]);
  instructions.push({ kind: 'calculate', opcode: 0 });
  call(0x64, [0, 1]);
  instructions.push(...variable(), ...literal(4), { kind: 'calculate', opcode: 0x11 }, { kind: 'calculate', opcode: 0 },
    { kind: 'jump', target: 'loop' }, { kind: 'label', name: 'after-loop' });
  call(0x64, [15, 1]);
  for (const actor of cast) { call(0x12, [actor.id]); spawn(actor, actor.next); }
  call(0x56, [65538]); call(0x64, [15, 1]);
  instructions.push({ kind: 'end' }, { kind: 'label', name: 'subtitles' });
  for (let row = 0; row < 3; row++) {
    if (row < 2) call(0x64, [17, 65537 + row]);
    else call(0x59, [100]);
    call(0xf4, [cast[0].id, -1, row]); call(0xf1, [cast[0].id, 0xae71b]);
    if (row === 1) for (const actor of cast) {
      call(0x1d, [actor.id, 64, 1]); instructions.push({ kind: 'calculate', opcode: 0 });
    }
    if (row === 2) for (const actor of cast) {
      call(0x1d, [actor.id, 64, -1]); instructions.push({ kind: 'calculate', opcode: 0 });
    }
  }
  instructions.push({ kind: 'end' });
  return { instructions, entries: [{ kind: 2, id: 3000, label: 'subtitles' }],
    messages: ['Before the staging loop.', 'After the staging loop.', 'Automatic eyes restored.'].map(text => [{ kind: 'text', text }]) };
}
