import type { Argument, Instruction } from './types';

/** Preview-only constant folding. Global state and native results stay unknown;
 * derived values are never exposed as editable literals. */
export function constantArguments(instructions: Instruction[], entries: Set<number>, edits: Map<number, number>): Instruction[] {
  const targets = new Set(instructions.flatMap(op => op.targetPc === undefined ? [] : [op.targetPc]));
  const values: (number | undefined)[] = [], args: (number | undefined)[] = [];
  let popped: number | undefined;
  const reset = () => { values.length = 0; args.length = 0; popped = undefined; };
  return instructions.map(op => {
    if (entries.has(op.pc) || targets.has(op.pc)) reset();
    const word = op.word;
    if (word <= 0xff || [0x100, 0x200, 0x300].includes(word)) {
      const literal = word <= 0xff ? (word << 24) >> 24
        : word === 0x100 ? (op.words[1] << 16) >> 16
        : word === 0x200 ? op.words[1] | op.words[2] << 16 : op.words[1];
      values.push(edits.get(op.pc) ?? literal);
    } else if ([0x1000, 0x1100, 0x1200].includes(word)) values.push(undefined);
    else if (word === 0x3000) popped = values.pop();
    else if (word === 0x4000) { args.push(popped); popped = undefined; }
    else if (word >> 12 === 3) {
      const code = word & 0xff;
      if ([5, 6, 7, 8].includes(code)) {
        const value = values.pop();
        values.push(value === undefined ? undefined : code === 5 ? -value | 0
          : code === 6 ? value : code === 7 ? ~value : Number(!value));
      } else if (code >= 0xf) {
        const right = values.pop(), left = values.pop();
        let value: number | undefined;
        if (left !== undefined && right !== undefined) {
          switch (code) {
            case 0x20: value = Number(left === right); break;
            case 0x21: value = Number(left !== right); break;
            case 0x22: value = Number(left <= right); break;
            case 0x23: value = Number(left >= right); break;
            case 0x24: value = Number(left > right); break;
            case 0x25: value = Number(left < right); break;
            case 0x26: value = Number(Boolean(left && right)); break;
            case 0x27: value = Number(Boolean(left || right)); break;
            case 0x31: value = left + right | 0; break;
            case 0x32: value = left - right | 0; break;
            case 0x33: value = Math.imul(left, right); break;
            case 0x34: if (right && !(left === -2147483648 && right === -1)) value = Math.trunc(left / right); break;
            case 0x35: if (right && !(left === -2147483648 && right === -1)) value = left % right; break;
            case 0x36: value = left & right; break;
            case 0x37: value = left | right; break;
            case 0x38: value = left ^ right; break;
            case 0x39: value = left << right; break;
            case 0x3a: value = left >> right; break;
          }
        }
        values.push(value);
      } else { values.length = 0; values.push(undefined); }
    } else if (op.nativeOpcode !== undefined) {
      const nested = op.nativeOpcode === 0x65 || op.nativeOpcode === 0x6f;
      const recovered = nested ? [args.pop()] : args.splice(0);
      const annotated = op.arguments?.length === recovered.length ? op.arguments.map((argument, i): Argument =>
        argument.value === undefined && recovered[i] !== undefined ? { value: recovered[i], editable: false } : argument)
        : recovered.length ? recovered.map(value => ({ value, editable: false })) : op.arguments;
      if (!nested) values.length = 0;
      if ([0x58, 0x65, 0x1c, 0x1d, 0x6a, 0x6f, 0xb8].includes(op.nativeOpcode)) values.push(undefined);
      return { ...op, arguments: annotated };
    } else if ([0x2001, 0x2002, 0x2003, 0x2004, 0x20ff].includes(word)) reset();
    return op;
  });
}
