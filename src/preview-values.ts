import type { Argument, Instruction } from './types';

interface Reference { offset: number; size: number }
interface Value { value?: number; reference?: Reference }

/** Saved edits use assembler objects rather than disassembled instructions.
 * Give them no original PC, so literal edits cannot accidentally target them. */
export function insertedInstruction(raw: object): Instruction {
  const op = raw as { kind: string; value?: number; offset?: number; width?: string; opcode?: number };
  let words: number[], nativeOpcode: number | undefined;
  if (op.kind === 'literal') words = [0x200, op.value! & 0xffff, op.value! >>> 16];
  else if (op.kind === 'loadGlobal') words = [op.width === 's8' ? 0x1000 : op.width === 's16' ? 0x1100 : 0x1200, op.offset!];
  else if (op.kind === 'calculate') words = [0x3000 | op.opcode!];
  else if (op.kind === 'argument') words = [0x4000];
  else if (op.kind === 'native') { words = [0x2000 | op.opcode!]; nativeOpcode = op.opcode; }
  else throw new Error('Inserted control flow cannot be reconstructed in this preview.');
  return { pc: -1, word: words[0], words, nativeOpcode, mnemonic: op.kind };
}

/** Known values along one executed preview path. Uninitialized game state and
 * native results stay unknown. Resolving an expression never makes it editable. */
export class PreviewValues {
  private values: Value[] = [];
  private arguments: (number | undefined)[] = [];
  private memory = new Map<number, number>();
  private popped: Value = {};

  constructor(private edits: Map<number, number>) {}

  get condition() { return this.popped.value; }

  private read(reference: Reference): Value {
    const { offset, size } = reference;
    let value = 0;
    for (let i = 0; i < size; i++) {
      const byte = this.memory.get(offset + i);
      if (byte === undefined) return { reference };
      value |= byte << (i * 8);
    }
    return { value: value << (32 - size * 8) >> (32 - size * 8), reference };
  }

  private store(reference: Reference | undefined, value: number | undefined) {
    if (!reference) { this.memory.clear(); return; }
    for (let i = 0; i < reference.size; i++) {
      if (value === undefined) this.memory.delete(reference.offset + i);
      else this.memory.set(reference.offset + i, value >>> (i * 8) & 255);
    }
  }

  private checkLimits() {
    if (this.values.length > 256 || this.arguments.length > 128) throw new Error('Preview expression stack limit reached.');
  }

  step(op: Instruction): Argument[] | undefined {
    const word = op.word;
    // Only a completed expression can supply a proven branch condition.
    if (word !== 0x3000 && word !== 0x4000 && ![0x2001, 0x2002, 0x2003, 0x2004, 0x20ff].includes(word)) this.popped = {};
    if (word <= 0xff || [0x100, 0x200, 0x300].includes(word)) {
      const literal = word <= 0xff ? word << 24 >> 24 : word === 0x100 ? op.words[1] << 16 >> 16
        : word === 0x200 ? op.words[1] | op.words[2] << 16 : op.words[1];
      this.values.push({ value: this.edits.get(op.pc) ?? literal });
    } else if ([0x1000, 0x1100, 0x1200].includes(word)) {
      this.values.push(this.read({ offset: op.words[1], size: word === 0x1000 ? 1 : word === 0x1100 ? 2 : 4 }));
    } else if (word === 0x3000) this.popped = this.values.pop() ?? {};
    else if (word === 0x4000) { this.arguments.push(this.popped.value); this.popped = {}; }
    else if (word >> 12 === 3) {
      const code = word & 0xff;
      if (code === 6) return;
      if (code >= 1 && code <= 8) {
        const operand = this.values.pop() ?? {}, old = operand.value;
        const value = old === undefined ? undefined : code === 1 || code === 3 ? old + 1 | 0
          : code === 2 || code === 4 ? old - 1 | 0 : code === 5 ? -old | 0 : code === 7 ? ~old : Number(!old);
        if (code <= 4) this.store(operand.reference, value);
        this.values.push({ value: code <= 2 ? old : value });
      } else if (code === 0xf) {
        const index = this.values.pop()?.value, base = this.values.pop()?.reference;
        this.values.push(base && index !== undefined
          ? this.read({ ...base, offset: (base.offset + index * base.size) & 0xffff }) : {});
      } else if (code >= 0x10) {
        const right = this.values.pop()?.value, left = this.values.pop() ?? {};
        const value = code === 0x10 ? right : calculate(code <= 0x1a ? code + 0x20 : code, left.value, right);
        if (code <= 0x1a) this.store(left.reference, value);
        this.values.push({ value });
      } else { this.values.length = 0; this.values.push({}); this.memory.clear(); }
    } else if (op.nativeOpcode !== undefined) {
      const opcode = op.nativeOpcode;
      // PC 0x565EE0 (random modulo) and 0x566A90 (sine) consume just one
      // argument and push a result inside a larger native-call expression.
      const nested = opcode === 0x65 || opcode === 0x6f;
      const recovered = nested ? [this.arguments.pop()] : this.arguments.splice(0);
      const original = op.arguments ?? [];
      const args = recovered.length === original.length ? original.map((argument, i) =>
        argument.value === undefined && recovered[i] !== undefined ? { value: recovered[i], editable: false } : argument)
        : recovered.length ? recovered.map(value => ({ value, editable: false })) : original;
      if (!nested) this.values.length = 0;
      if ([0x58, 0x65, 0x1c, 0x1d, 0x39, 0x6a, 0x6f, 0xb8].includes(opcode)) this.values.push({});
      this.checkLimits();
      return args;
    }
    // A corrupt draft must not grow the stacks without bound during tracing.
    this.checkLimits();
  }
}

function calculate(code: number, left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined || right === undefined) return undefined;
  switch (code) {
    case 0x20: return Number(left === right);
    case 0x21: return Number(left !== right);
    case 0x22: return Number(left <= right);
    case 0x23: return Number(left >= right);
    case 0x24: return Number(left > right);
    case 0x25: return Number(left < right);
    case 0x26: return Number(Boolean(left && right));
    case 0x27: return Number(Boolean(left || right));
    case 0x31: return left + right | 0;
    case 0x32: return left - right | 0;
    case 0x33: return Math.imul(left, right);
    case 0x34: return right && !(left === -2147483648 && right === -1) ? Math.trunc(left / right) : undefined;
    case 0x35: return right && !(left === -2147483648 && right === -1) ? left % right : undefined;
    case 0x36: return left & right;
    case 0x37: return left | right;
    case 0x38: return left ^ right;
    case 0x39: return left << right;
    case 0x3a: return left >> right;
  }
}
