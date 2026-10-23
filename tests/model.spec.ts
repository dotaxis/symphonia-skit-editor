import { test, expect } from '@playwright/test';
import { dialogueLines, updateLiteral } from '../src/model';
import type { Argument, Instruction, Session } from '../src/types';

const argument = (value: number, literalPc: number, editable = true): Argument => ({ value, literalPc, editable });
const call = (pc: number, nativeOpcode: number, values: number[]): Instruction => ({
  pc, word: 0x2000 | nativeOpcode, nativeOpcode, mnemonic: 'native', words: [0x2000 | nativeOpcode],
  arguments: values.map((value, index) => argument(value, pc * 16 + index)),
});
const end = (pc: number): Instruction => ({ pc, word: 0x20ff, mnemonic: 'end', words: [0x20ff] });
const text = (pc: number, message = 0) => call(pc, 0xf4, [999, -1, message]);
const active = (pc: number, actor: number, mode = 0xae71b) => call(pc, 0xf1, [actor, mode]);
function session(instructions: Instruction[], entries: Session['document']['entries'] = []): Session {
  return {
    filename: 'FC_W001.SKP', original: new Uint8Array(), edits: { messages: [], literals: [] },
    document: {
      format: 'test', version: 1, byteLength: 0, scenarioOffset: 0, scenarioSize: 0,
      codeOffset: 0, dataOffset: 0, defaultPc: instructions[0]?.pc ?? 0, entries,
      messages: Array.from({ length: 4 }, (_, index) => ({ index, offset: 0, byteLength: 1, editable: true,
        tokens: [{ kind: 'text' as const, text: `Line ${index}` }], text: `Line ${index}` })),
      instructions, diagnostics: [], codeEditable: true,
    },
  };
}

test('speaker projection skips stop cues and edits every activation of the selected actor', () => {
  const original = session([text(0), active(1, 9, 0x604f1), active(2, 1), call(3, 0x59, [100]),
    active(4, 1, 0x604f1), active(5, 1), active(6, 2), active(7, 1), end(8)]);
  const line = dialogueLines(original)[0];
  expect(line.speaker?.value).toBe(1);
  expect(line.speakerPc).toBe(2);
  expect(line.speakerCues.map(cue => cue.value)).toEqual([1, 1, 2, 1]);
  expect(line.multiSpeaker).toBe(true);
  const edits = line.speakerCues.filter(cue => cue.value === line.speaker?.value)
    .reduce((value, cue) => updateLiteral(value, cue, 3), original.edits);
  const changed = dialogueLines({ ...original, edits })[0];
  expect(changed.speakerCues.map(cue => cue.value)).toEqual([3, 3, 2, 3]);
  expect(original.document.instructions[2].arguments?.[0].value).toBe(1);
});

test('speaker inheritance is read only and cannot leak across stop, END, RETURN or registry entries', () => {
  const document = session([text(0), active(1, 1), text(2, 1), text(3, 2), active(4, 1, 0x604f1),
    text(5, 3), active(6, 2), end(7), text(8), active(9, 3),
    { pc: 10, word: 0x2003, mnemonic: 'return', words: [0x2003] },
    text(11), active(12, 4), text(13)], [{ kind: 2, id: 4000, pc: 13 }]);
  const rows = dialogueLines(document);
  expect(rows[1].speaker).toMatchObject({ value: 1, editable: false });
  expect(rows[1].speakerInherited).toBe(true);
  expect(rows[1].speakerCues).toEqual([]);
  expect(rows[2].speaker).toBeUndefined();
  expect(rows[4].speaker?.value).toBe(3);
  expect(rows[5].speaker?.value).toBe(4);
  expect(rows[6].speaker).toBeUndefined();
});

test('canonical subtitle voice waits pair only with an unambiguous main-context launch', () => {
  const document = session([call(0, 0x56, [0x10001]), call(1, 0x56, [0x10002]), call(2, 0x56, [0x10002]), end(3),
    call(4, 0x64, [17, 0x10001]), text(5), active(6, 1), text(7, 1),
    call(8, 0x64, [17, 0x10002]), text(9, 2), end(10),
    text(11), call(12, 0x56, [0x10001]), call(13, 0x64, [17, 0x10001]), text(14), end(15)],
  [{ kind: 2, id: 3000, pc: 4 }, { kind: 2, id: 4000, pc: 11 }]);
  const rows = dialogueLines(document);
  expect(rows[0].voice?.value).toBe(0x10001);
  expect(rows[1].voice?.value).toBe(0x10001);
  expect(rows[2].voice).toBeUndefined();
  expect(rows[2].voiceAmbiguous).toBe(true);
  expect(rows[3].voiceWait).toBeUndefined();
  expect(rows[4].voiceWait?.value).toBe(0x10001);
  expect(rows[4].voice).toBeUndefined();
});

test('single-context authored voices are projected directly and stop clears the current clip', () => {
  const rows = dialogueLines(session([call(0, 0x56, [0x30001]), text(1), active(2, 1),
    call(3, 0x56, [-1]), text(4, 1), end(5), text(6, 2)]));
  expect(rows[0].voice?.value).toBe(0x30001);
  expect(rows[1].voice).toBeUndefined();
  expect(rows[2].voice).toBeUndefined();
});

test('a computed later speaker cue blocks a partial speaker edit', () => {
  const document = session([text(0), active(1, 1), active(2, 1), end(3)]);
  document.document.instructions[2].arguments![0].editable = false;
  const line = dialogueLines(document)[0];
  expect(line.speaker?.editable).toBe(false);
  expect(line.speakerCues).toHaveLength(2);
});

test('field-style dialogue rows expose body text without invented portrait or timing bindings', () => {
  const document = session([call(0, 0x56, [0x10001]), call(1, 0x0c, [0, 0, -2, 7, 0, 0, 0, 1]),
    active(2, 7), call(3, 0x59, [100]), call(4, 0x0c, [0, 0, -2, 7, 0, 0, 2, 3]), end(5)]);
  const rows = dialogueLines(document);
  expect(rows.map(row => row.messageIndex)).toEqual([1, 3]);
  expect(rows.every(row => row.binding === 'dialogue')).toBe(true);
  for (const row of rows) {
    expect(row.speaker).toBeUndefined();
    expect(row.speakerPc).toBeUndefined();
    expect(row.speakerCues).toEqual([]);
    expect(row.voice).toBeUndefined();
    expect(row.timing).toBeUndefined();
  }
});

test('files without recognized dialogue calls expose only nonempty text messages as fallback rows', () => {
  const document = session([end(0)]);
  document.document.messages[0].tokens = [{ kind: 'text', text: '  \n ' }];
  document.document.messages[1].tokens = [{ kind: 'protected', hex: '01', label: 'Control' }];
  const rows = dialogueLines(document);
  expect(rows.map(row => row.messageIndex)).toEqual([2, 3]);
  expect(rows.every(row => row.binding === 'message' && !row.speaker && !row.timing)).toBe(true);
  expect(dialogueLines(session([text(0), end(1)]))).toHaveLength(1);
});
