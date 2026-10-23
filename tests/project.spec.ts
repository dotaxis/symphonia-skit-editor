import { test, expect } from '@playwright/test';
import { readProject } from '../src/project';

const saved = () => ({
  format: 'tos-skit-project', version: 1, kind: 'authored', project: {
    filename: 'FC_W001.SKP', actors: [{ id: 1, name: 'A label', textureSlot: 0, x: 320, y: 200 }],
    rows: [{ id: 'first', text: 'Unfinished café draft.', speaker: 1, durationTicks: 180 }],
  },
});
const retail = (edits?: unknown) => ({ format: 'tos-skit-project', version: 1, kind: 'retail', filename: 'FC_W001.SKP', original: 'AgAAAA==', edits });

test('normalizes missing frontend defaults without discarding an unfinished draft', () => {
  const input = saved();
  const value = readProject(input);
  expect(value.kind).toBe('authored');
  if (value.kind !== 'authored') throw new Error('Wrong kind');
  expect(value.project.rows[0]).toMatchObject({ text: 'Unfinished café draft.', stage: [], eyeFrame: -1, mouthFrame: -1, voiceId: null, voiceEnabled: false });
  expect(value.project.actors[0]).toMatchObject({ scalePercent: 100, rotation: 0, alpha: 255 });
  expect(input.project.rows[0]).not.toHaveProperty('stage');
  const source = saved(); source.project.actors[0].x = 999999; source.project.rows[0].durationTicks = 0;
  expect(() => readProject(source)).not.toThrow();
});

test('retail default edit arrays and invalid-to-game text remain recoverable', () => {
  expect(readProject(retail())).toMatchObject({ edits: { messages: [], literals: [] } });
  expect(readProject(retail({}))).toMatchObject({ edits: { messages: [], literals: [] } });
  const value = readProject(retail({ messages: [{ index: 0, tokens: [{ kind: 'text', text: 'Draft é\u0000 to repair' }] }] }));
  expect(value).toMatchObject({ edits: { messages: [{ tokens: [{ text: 'Draft é\u0000 to repair' }] }], literals: [] } });
});

test('rejects labels and filenames that React cannot render or save', () => {
  const actorName = saved() as any; actorName.project.actors[0].name = { dangerous: 'object child' };
  expect(() => readProject(actorName)).toThrow('must be text');
  const filename = saved() as any; filename.project.filename = {};
  expect(() => readProject(filename)).toThrow('filename must be text');
  expect(() => readProject({ ...retail(), filename: {} })).toThrow('filename must be text');
  const rowText = saved() as any; rowText.project.rows[0].text = null;
  expect(() => readProject(rowText)).toThrow('must be text');
});

test('rejects duplicate IDs and supplies stable unique missing row IDs', () => {
  const actors = saved(); actors.project.actors.push({ ...actors.project.actors[0] });
  expect(() => readProject(actors)).toThrow('duplicate ID');
  const rows = saved(); rows.project.rows.push({ ...rows.project.rows[0] });
  expect(() => readProject(rows)).toThrow('duplicate ID');
  const omitted = saved() as any; delete omitted.project.rows[0].id;
  omitted.project.rows.push({ text: 'Existing ID collision.', speaker: 1, durationTicks: 60, id: 'imported-line-1' });
  const normalized = readProject(omitted);
  if (normalized.kind !== 'authored') throw new Error('Wrong kind');
  expect(normalized.project.rows.map(row => row.id)).toEqual(['imported-line-1-', 'imported-line-1']);
});

test('empty drafts still validate all actor and project fields', () => {
  const empty = saved() as any; empty.project.rows = []; empty.project.actors = [null];
  expect(() => readProject(empty)).toThrow('Actor 1 must be an object');
  empty.project.actors = [];
  expect(readProject(empty)).toMatchObject({ project: { rows: [], actors: [] } });
  empty.project.filename = false;
  expect(() => readProject(empty)).toThrow('filename must be text');
});

test('rejects malformed stage and frame fields before a workspace is replaced', () => {
  const stage = saved() as any; stage.project.rows[0].stage = {};
  expect(() => readProject(stage)).toThrow('stage must be an array');
  stage.project.rows[0].stage = [{ actorId: 1, visible: 'false' }];
  expect(() => readProject(stage)).toThrow('visible must be true or false');
  stage.project.rows[0].stage = [];
  stage.project.rows[0].eyeFrame = {};
  expect(() => readProject(stage)).toThrow('finite whole number');
  stage.project.rows[0].eyeFrame = 0;
  expect(readProject(stage)).toMatchObject({ project: { rows: [{ eyeFrame: 0 }] } });
});

test('validates all edit structures while retaining supported structural changes', () => {
  const edits = {
    insertions: [{ beforePc: 1, instructions: [{ kind: 'literal', value: 3 }, { kind: 'calculate', opcode: 0 }, { kind: 'argument' }, { kind: 'native', opcode: 89 }] }],
    deletions: [{ startPc: 3, endPc: 5 }],
  };
  expect(readProject(retail(edits))).toMatchObject({ edits: { ...edits, messages: [], literals: [] } });
  expect(() => readProject(retail({ messages: null }))).toThrow('must be an array');
  expect(() => readProject(retail({ literals: [{ pc: 1, value: 2 }, { pc: 1, value: 3 }] }))).toThrow('duplicate ID');
  expect(() => readProject(retail({ messages: [{ index: 0, tokens: [{ kind: 'protected', hex: 'z0', label: 'Bad bytes' }] }] }))).toThrow('hexadecimal');
  expect(() => readProject(retail({ insertions: [{ beforePc: 0, instructions: [{ kind: 'literal', value: {} }] }] }))).toThrow('finite whole number');
  expect(() => readProject(retail({ insertions: [{ beforePc: 0, instructions: [{ kind: 'unknown' }] }] }))).toThrow('unsupported instruction');
});

test('rejects unsupported schema and fields rather than silently dropping them', () => {
  expect(() => readProject({ ...saved(), version: 2 })).toThrow('not a supported');
  expect(() => readProject(null)).toThrow('must be an object');
  const value = saved() as any; value.project.rows[0].speakerId = 2;
  expect(() => readProject(value)).toThrow('unsupported field: speakerId');
});
