import type { AuthoredCast, AuthoredLine, AuthoredProject, EditSet, StageChange, Token } from './types';

export interface SavedEdits extends EditSet {
  deletions?: { startPc: number; endPc: number }[];
}
export type SavedProject =
  | { kind: 'retail'; filename: string; original: string; edits: SavedEdits }
  | { kind: 'authored'; project: AuthoredProject };

type ObjectValue = Record<string, unknown>;
function object(value: unknown, where: string): ObjectValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${where} must be an object.`);
  return value as ObjectValue;
}
function fields(value: ObjectValue, allowed: string[], where: string) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${where} contains an unsupported field: ${key}.`);
}
function array(value: unknown, where: string, fallback = false): unknown[] {
  if (value === undefined && fallback) return [];
  if (!Array.isArray(value)) throw new Error(`${where} must be an array.`);
  return value;
}
function string(value: unknown, where: string): string {
  if (typeof value !== 'string') throw new Error(`${where} must be text.`);
  return value;
}
function integer(value: unknown, where: string, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`${where} must be a finite whole number.`);
  return value;
}
function index(value: unknown, where: string): number {
  const parsed = integer(value, where);
  if (parsed < 0) throw new Error(`${where} must not be negative.`);
  return parsed;
}
function boolean(value: unknown, where: string, fallback?: boolean): boolean {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${where} must be true or false.`);
  return value;
}
function unique<T extends string | number>(seen: Set<T>, id: T, where: string) {
  if (seen.has(id)) throw new Error(`${where} contains a duplicate ID: ${id}.`);
  seen.add(id);
}

function token(value: unknown, where: string): Token {
  const parsed = object(value, where);
  if (parsed.kind === 'text') {
    fields(parsed, ['kind', 'text'], where);
    // Drafts may contain text the game cannot encode. Preserve it for correction;
    // the Rust export validator, rather than project loading, checks encoding.
    return { kind: 'text', text: string(parsed.text, `${where}.text`) };
  }
  if (parsed.kind === 'protected') {
    fields(parsed, ['kind', 'hex', 'label'], where);
    const hex = string(parsed.hex, `${where}.hex`);
    if (!/^(?:[\da-fA-F]{2})*$/.test(hex)) throw new Error(`${where}.hex must contain complete hexadecimal bytes.`);
    return { kind: 'protected', hex, label: parsed.label === undefined ? 'Original control' : string(parsed.label, `${where}.label`) };
  }
  throw new Error(`${where} has an unsupported token kind.`);
}

function instruction(value: unknown, where: string): object {
  const parsed = object(value, where);
  const kind = string(parsed.kind, `${where}.kind`);
  switch (kind) {
    case 'literal':
      fields(parsed, ['kind', 'value'], where);
      return { kind, value: integer(parsed.value, `${where}.value`) };
    case 'loadGlobal': {
      fields(parsed, ['kind', 'offset', 'width'], where);
      if (!['s8', 's16', 's32'].includes(string(parsed.width, `${where}.width`))) throw new Error(`${where}.width is unsupported.`);
      return { kind, offset: index(parsed.offset, `${where}.offset`), width: parsed.width };
    }
    case 'argument': case 'end': case 'return':
      fields(parsed, ['kind'], where);
      return { kind };
    case 'calculate': case 'native':
      fields(parsed, ['kind', 'opcode'], where);
      return { kind, opcode: index(parsed.opcode, `${where}.opcode`) };
    case 'label':
      fields(parsed, ['kind', 'name'], where);
      return { kind, name: string(parsed.name, `${where}.name`) };
    case 'jump': case 'call': case 'branchFalse':
      fields(parsed, ['kind', 'target'], where);
      return { kind, target: string(parsed.target, `${where}.target`) };
    default: throw new Error(`${where} has an unsupported instruction kind.`);
  }
}

function edits(value: unknown): SavedEdits {
  const parsed = value === undefined ? {} : object(value, 'Project edits');
  fields(parsed, ['messages', 'literals', 'insertions', 'deletions'], 'Project edits');
  const messageIds = new Set<number>(), literalPcs = new Set<number>();
  const result: SavedEdits = {
    messages: array(parsed.messages, 'Message edits', true).map((value, i) => {
      const where = `Message edit ${i + 1}`, item = object(value, where);
      fields(item, ['index', 'tokens'], where);
      const id = index(item.index, `${where}.index`); unique(messageIds, id, 'Message edits');
      return { index: id, tokens: array(item.tokens, `${where}.tokens`).map((value, j) => token(value, `${where} token ${j + 1}`)) };
    }),
    literals: array(parsed.literals, 'Literal edits', true).map((value, i) => {
      const where = `Literal edit ${i + 1}`, item = object(value, where);
      fields(item, ['pc', 'value'], where);
      const pc = index(item.pc, `${where}.pc`); unique(literalPcs, pc, 'Literal edits');
      return { pc, value: integer(item.value, `${where}.value`) };
    }),
  };
  if (parsed.insertions !== undefined) result.insertions = array(parsed.insertions, 'Insertions').map((value, i) => {
    const where = `Insertion ${i + 1}`, item = object(value, where);
    fields(item, ['beforePc', 'instructions'], where);
    return { beforePc: index(item.beforePc, `${where}.beforePc`), instructions: array(item.instructions, `${where}.instructions`).map((value, j) => instruction(value, `${where} instruction ${j + 1}`)) };
  });
  if (parsed.deletions !== undefined) result.deletions = array(parsed.deletions, 'Deletions').map((value, i) => {
    const where = `Deletion ${i + 1}`, item = object(value, where);
    fields(item, ['startPc', 'endPc'], where);
    return { startPc: index(item.startPc, `${where}.startPc`), endPc: index(item.endPc, `${where}.endPc`) };
  });
  return result;
}

function actor(value: unknown, where: string): AuthoredCast {
  const parsed = object(value, where);
  fields(parsed, ['id', 'name', 'textureSlot', 'x', 'y', 'scalePercent', 'rotation', 'alpha'], where);
  const id = integer(parsed.id, `${where}.id`);
  return {
    id, name: parsed.name === undefined ? `Character ${id}` : string(parsed.name, `${where}.name`),
    textureSlot: integer(parsed.textureSlot, `${where}.textureSlot`),
    x: integer(parsed.x, `${where}.x`), y: integer(parsed.y, `${where}.y`),
    scalePercent: integer(parsed.scalePercent, `${where}.scalePercent`, 100),
    rotation: integer(parsed.rotation, `${where}.rotation`, 0), alpha: integer(parsed.alpha, `${where}.alpha`, 255),
  };
}
function stage(value: unknown, where: string): StageChange {
  const parsed = object(value, where);
  const numbers = ['x', 'y', 'textureSlot', 'scalePercent', 'movementTicks', 'fadeTicks', 'rotation', 'alpha'] as const;
  fields(parsed, ['actorId', 'visible', ...numbers], where);
  const result: StageChange = { actorId: integer(parsed.actorId, `${where}.actorId`) };
  for (const field of numbers) if (parsed[field] !== undefined) result[field] = integer(parsed[field], `${where}.${field}`);
  if (parsed.visible !== undefined) result.visible = boolean(parsed.visible, `${where}.visible`);
  return result;
}
function authored(value: unknown): AuthoredProject {
  const parsed = object(value, 'Authored project');
  fields(parsed, ['filename', 'actors', 'rows'], 'Authored project');
  const actors = array(parsed.actors, 'Project actors').map((value, i) => actor(value, `Actor ${i + 1}`));
  const actorIds = new Set<number>(); for (const actor of actors) unique(actorIds, actor.id, 'Project actors');
  const rawRows = array(parsed.rows, 'Project rows').map((value, i) => object(value, `Row ${i + 1}`));
  const rowIds = new Set<string>();
  for (const [i, item] of rawRows.entries()) if (item.id !== undefined) {
    const id = string(item.id, `Row ${i + 1}.id`);
    if (!id) throw new Error(`Row ${i + 1}.id must not be empty.`);
    unique(rowIds, id, 'Project rows');
  }
  const rows: AuthoredLine[] = rawRows.map((item, i) => {
    const where = `Row ${i + 1}`;
    fields(item, ['id', 'text', 'speaker', 'voiceId', 'voiceEnabled', 'durationTicks', 'eyeFrame', 'mouthFrame', 'stage'], where);
    let id = item.id as string | undefined;
    if (id === undefined) { id = `imported-line-${i + 1}`; while (rowIds.has(id)) id += '-'; rowIds.add(id); }
    return {
      id, text: string(item.text, `${where}.text`), speaker: integer(item.speaker, `${where}.speaker`),
      durationTicks: integer(item.durationTicks, `${where}.durationTicks`),
      voiceId: item.voiceId === undefined || item.voiceId === null ? null : integer(item.voiceId, `${where}.voiceId`),
      voiceEnabled: boolean(item.voiceEnabled, `${where}.voiceEnabled`, false),
      eyeFrame: integer(item.eyeFrame, `${where}.eyeFrame`, -1), mouthFrame: integer(item.mouthFrame, `${where}.mouthFrame`, -1),
      stage: array(item.stage, `${where}.stage`, true).map((value, j) => stage(value, `${where} stage event ${j + 1}`)),
    };
  });
  return { filename: string(parsed.filename, 'Project filename'), actors, rows };
}

/** Validate the complete shape consumed by React before replacing a workspace.
 * Numeric game limits, text encoding, references and program validity are export
 * concerns: a structurally valid unfinished draft must remain recoverable. */
export function readProject(value: unknown): SavedProject {
  const parsed = object(value, 'Project');
  if (parsed.format !== 'tos-skit-project' || parsed.version !== 1) throw new Error('This is not a supported skit editor project.');
  if (parsed.kind === 'retail') {
    fields(parsed, ['format', 'version', 'kind', 'filename', 'original', 'edits', 'assets'], 'Project');
    return { kind: 'retail', filename: string(parsed.filename, 'Project filename'), original: string(parsed.original, 'Original bytes'), edits: edits(parsed.edits) };
  }
  if (parsed.kind === 'authored') {
    fields(parsed, ['format', 'version', 'kind', 'project', 'assets'], 'Project');
    return { kind: 'authored', project: authored(parsed.project) };
  }
  throw new Error('The project has an unsupported script kind.');
}
