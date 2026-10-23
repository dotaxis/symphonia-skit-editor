import type { Argument, AuthoredLine, AuthoredProject, DialogueLine, EditSet, Instruction, MessageRecord, Portrait, Session, Token } from './types';

export const emptyEdits = (): EditSet => ({ messages: [], literals: [] });
export const visibleText = (tokens: Token[]) => tokens.map(token => token.kind === 'text' ? token.text : `⟦${token.label}⟧`).join('');
export function effectiveMessages(session: Session): MessageRecord[] {
  return session.document.messages.map(message => {
    const edit = session.edits.messages.find(item => item.index === message.index);
    return edit ? { ...message, tokens: edit.tokens, text: visibleText(edit.tokens) } : message;
  });
}
export function effectiveInstructions(session: Session): Instruction[] {
  return session.document.instructions.map(instruction => ({ ...instruction, arguments: instruction.arguments?.map(argument => {
    const edit = session.edits.literals.find(item => item.pc === argument.literalPc);
    return edit ? { ...argument, value: edit.value } : argument;
  }) }));
}
export function dialogueLines(session: Session): DialogueLine[] {
  const instructions = effectiveInstructions(session);
  const lines: DialogueLine[] = [];
  const entryPcs = new Set([session.document.defaultPc, ...session.document.entries.map(entry => entry.pc)]);
  // A registry entry is an independent VM context. END and RETURN also prevent
  // state from leaking into code laid out immediately after the current body.
  const regionByIndex: number[] = [];
  let region = -1;
  for (let i = 0; i < instructions.length; i++) {
    if (!i || entryPcs.has(instructions[i].pc) || [0x20ff, 0x2003].includes(instructions[i - 1].word)) region++;
    regionByIndex[i] = region;
  }
  const mainIndex = instructions.findIndex(op => op.pc === session.document.defaultPc);
  const mainRegion = regionByIndex[mainIndex];
  const subtitleRegions = new Set(session.document.entries
    .filter(entry => entry.kind === 2 && entry.id === 3000)
    .map(entry => regionByIndex[instructions.findIndex(op => op.pc === entry.pc)]));
  const mainVoices = instructions.filter((op, i) => regionByIndex[i] === mainRegion && op.nativeOpcode === 0x56);
  let voiceWait: Argument | undefined;
  let directVoice: Argument | undefined;
  let inheritedSpeaker: Argument | undefined;
  let activeActors = new Set<number>();
  for (let i = 0; i < instructions.length; i++) {
    const op = instructions[i];
    const args = op.arguments ?? [];
    if (!i || regionByIndex[i] !== regionByIndex[i - 1]) {
      voiceWait = undefined; directVoice = undefined; inheritedSpeaker = undefined;
      activeActors = new Set();
    }
    if (op.nativeOpcode === 0x56) {
      directVoice = args[0]?.value !== undefined && args[0].value > 0 ? args[0] : undefined;
      voiceWait = undefined;
    }
    if (op.nativeOpcode === 0x64 && args[0]?.value === 17) {
      voiceWait = args[1]; directVoice = undefined;
    }
    if (op.nativeOpcode === 0xf1) {
      const mode = args[1]?.value;
      if (mode === 0x604f1 || mode === undefined) {
        inheritedSpeaker = undefined; activeActors.clear();
      } else {
        if (mode === 0xae71b) activeActors.clear();
        inheritedSpeaker = args[0];
        if (args[0]?.value !== undefined) activeActors.add(args[0].value);
      }
    }
    if (op.nativeOpcode === 0x0c && args[7]?.value !== undefined) {
      // PC dialogue configuration stores the body in arg 7; arg 6 can be a
      // speaker/title record and remains available through the message table.
      // This does not share the portrait subtitle/mouth-cue editing model.
      const messageIndex = args[7].value;
      if (session.document.messages[messageIndex]) lines.push({
        key: `dialogue-${op.pc}`, binding: 'dialogue', instructionPc: op.pc,
        messageIndex, speakerCues: [], multiSpeaker: false,
      });
      continue;
    }
    if (op.nativeOpcode !== 0xf4 || args[2]?.value === undefined) continue;
    const messageIndex = args[2].value!;
    if (!session.document.messages[messageIndex]) continue;
    const line: DialogueLine = {
      key: `pc-${op.pc}`, binding: 'skit', instructionPc: op.pc, startPc: op.pc, messageIndex,
      voiceWait, voice: directVoice, speakerCues: [], multiSpeaker: false,
    };
    if (voiceWait?.value !== undefined && subtitleRegions.has(regionByIndex[i])) {
      // Retail subtitles and voice playback run in two distinct contexts. Only
      // the known subtitle entry may pair with a unique call in the main body.
      // Repeated clip IDs cannot safely identify one editable launch command.
      const voiceId = voiceWait.value;
      const matching = mainVoices.filter(item => item.arguments?.[0]?.value === voiceId);
      if (matching.length === 1) line.voice = matching[0].arguments?.[0];
      else if (matching.length > 1) line.voiceAmbiguous = true;
    }
    let stoppedBeforeActivation = false;
    const rowActors = new Set<number>();
    for (let j = i + 1; j < instructions.length; j++) {
      const next = instructions[j];
      if (regionByIndex[j] !== regionByIndex[i] || next.nativeOpcode === 0xf4 || [0x20ff, 0x2003].includes(next.word)) {
        line.endPc = next.pc;
        break;
      }
      if (next.nativeOpcode === 0xf1) {
        const actor = next.arguments?.[0], mode = next.arguments?.[1];
        if (mode?.value === undefined || mode.value === 0x604f1) {
          if (!line.speaker) stoppedBeforeActivation = true;
          continue;
        }
        if (!actor || actor.value === undefined) {
          if (!line.speaker) stoppedBeforeActivation = true;
          continue;
        }
        line.speakerCues.push(actor);
        rowActors.add(actor.value);
        if (!line.speaker) {
          line.speaker = actor; line.speakerMode = mode; line.speakerPc = next.pc;
          if (mode.value !== 0xae71b && !stoppedBeforeActivation) for (const id of activeActors) rowActors.add(id);
        }
      }
      if (next.nativeOpcode === 0x59 && !line.timing) line.timing = next.arguments?.[0];
    }
    if (line.speaker) {
      // Editing just the first activation lets later mouth pulses restore the
      // original actor. All matching cues must be safe literal edit targets.
      line.speaker = { ...line.speaker, editable: line.speakerCues
        .filter(cue => cue.value === line.speaker?.value).every(cue => cue.editable) };
    } else if (!stoppedBeforeActivation && inheritedSpeaker?.value !== undefined) {
      line.speaker = { ...inheritedSpeaker, editable: false };
      line.speakerInherited = true;
      for (const id of activeActors) rowActors.add(id);
    }
    line.multiSpeaker = rowActors.size > 1;
    lines.push(line);
  }
  if (!instructions.some(op => op.nativeOpcode === 0xf4 || op.nativeOpcode === 0x0c)) {
    for (const message of effectiveMessages(session)) {
      if (message.tokens.some(token => token.kind === 'text' && token.text.trim().length > 0)) lines.push({
        key: `message-${message.index}`, binding: 'message', messageIndex: message.index,
        speakerCues: [], multiSpeaker: false,
      });
    }
  }
  return lines;
}
export function portraits(session: Session): Portrait[] {
  const seen = new Set<number>();
  const result: Portrait[] = [];
  for (const op of effectiveInstructions(session)) {
    const args = op.arguments ?? [];
    if (op.nativeOpcode !== 0x57 || args.length < 13 || args[0].value === undefined) continue;
    if (seen.has(args[0].value)) continue;
    seen.add(args[0].value);
    result.push({ actorId: args[0].value, resourceId: (args[12].value ?? 0) & 0xffff,
      x: args[2].value ?? 0, y: args[3].value ?? 0, scale: 1, expression: 0, args, pc: op.pc });
  }
  return result;
}
export function updateMessage(edits: EditSet, index: number, tokens: Token[]): EditSet {
  return { ...edits, messages: [...edits.messages.filter(item => item.index !== index), { index, tokens }] };
}
export function updateLiteral(edits: EditSet, argument: Argument | undefined, value: number): EditSet {
  if (!argument?.editable || argument.literalPc === undefined) throw new Error('This value is computed by the original script and cannot be edited as a constant.');
  if (!Number.isInteger(value)) throw new Error('Use a whole number.');
  return { ...edits, literals: [...edits.literals.filter(item => item.pc !== argument.literalPc), { pc: argument.literalPc, value }] };
}
export function newLine(speaker = 1): AuthoredLine {
  return { id: crypto.randomUUID(), text: '', speaker, voiceId: null, voiceEnabled: false, durationTicks: 180,
    eyeFrame: -1, mouthFrame: -1, stage: [] };
}
export function newProject(): AuthoredProject {
  return { filename: 'FC_W001.SKP', actors: [{ id: 1, name: 'Character 1', textureSlot: 0, x: 320, y: 200, scalePercent: 100, rotation: 0, alpha: 255 }], rows: [newLine()] };
}
export function toAuthored(session: Session): AuthoredProject {
  const cast = portraits(session).map(portrait => ({ id: portrait.actorId, name: `Character ${portrait.actorId}`, textureSlot: portrait.resourceId,
    x: portrait.x, y: portrait.y, scalePercent: 100, rotation: portrait.args[6]?.value ?? 0, alpha: portrait.args[10]?.value ?? 255 }));
  const messages = effectiveMessages(session);
  return { filename: session.filename, actors: cast.length ? cast : newProject().actors,
    rows: dialogueLines(session).map(line => ({ ...newLine(line.speaker?.value ?? cast[0]?.id ?? 1),
      text: messages[line.messageIndex]?.tokens.filter((token): token is {kind:'text';text:string} => token.kind === 'text').map(token => token.text).join('') ?? '',
      voiceId: line.voice?.value ?? null, voiceEnabled: !!line.voice?.value })) };
}
export function warningsForText(text: string) {
  const result: string[] = [];
  if (/[^\x20-\x7e\n]/.test(text)) result.push('English export supports printable ASCII and line breaks. Replace unsupported characters.');
  if (text.split('\n').length > 3) result.push('More than three lines: check text-box fit in game.');
  if (text.split('\n').some(line => line.length > 52)) result.push('Long line: the browser font is approximate; check wrapping in game.');
  return result;
}
