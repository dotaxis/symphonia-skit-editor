export type Token = { kind: 'text'; text: string } | { kind: 'protected'; hex: string; label: string };
export interface MessageRecord {
  index: number; offset: number; byteLength: number; editable: boolean; tokens: Token[]; text: string;
}
export interface Argument { value?: number; literalPc?: number; operandPc?: number; wordCount?: number; editable: boolean }
export interface Instruction {
  pc: number; word: number; mnemonic: string; words: number[]; targetPc?: number;
  nativeOpcode?: number; arguments?: Argument[];
}
export interface Diagnostic { severity: string; message: string; pc?: number }
export interface SkitDocument {
  format: string; version: number; byteLength: number; scenarioOffset: number; scenarioSize: number;
  codeOffset: number; dataOffset: number; defaultPc: number;
  entries: { kind: number; id: number; pc: number }[];
  messages: MessageRecord[]; instructions: Instruction[]; diagnostics: Diagnostic[]; codeEditable: boolean;
}
export interface EditSet {
  messages: { index: number; tokens: Token[] }[];
  literals: { pc: number; value: number }[];
  insertions?: { beforePc: number; instructions: object[] }[];
  deletions?: { startPc: number; endPc: number }[];
}
export interface Session {
  filename: string; original: Uint8Array; document: SkitDocument; edits: EditSet;
}
export interface DialogueLine {
  key: string; messageIndex: number; instructionPc?: number; speaker?: Argument;
  binding?: 'skit' | 'dialogue' | 'message';
  voice?: Argument; voiceWait?: Argument; timing?: Argument; speakerMode?: Argument;
  startPc?: number; endPc?: number;
  speakerPc?: number;
  speakerCues: Argument[]; multiSpeaker: boolean; speakerInherited?: boolean;
  voiceAmbiguous?: boolean;
}
export interface Portrait {
  actorId: number; resourceId: number; x: number; y: number; scale: number;
  expression: number; args: Argument[]; pc: number;
}
export type CoreOperation = 'parse_skit' | 'compile_skit' | 'create_skit' | 'author_skit' | 'decode_texture' | 'inspect_assets' | 'decode_audio';
export interface Texture { width: number; height: number; rgba: number[] }
export interface AudioData { sample_rate: number; channels: number; pcm: number[] }
export interface AwbEntry { id: number; offset: number; size: number }
export interface AuthoredCast { id: number; name: string; textureSlot: number; x: number; y: number; scalePercent: number; rotation: number; alpha: number }
export interface StageChange { actorId: number; x?: number; y?: number; textureSlot?: number; scalePercent?: number; visible?: boolean; movementTicks?: number; fadeTicks?: number; rotation?: number; alpha?: number }
export interface AuthoredLine { id: string; text: string; speaker: number; voiceId: number | null; voiceEnabled: boolean; durationTicks: number; eyeFrame: number; mouthFrame: number; stage: StageChange[] }
export interface AuthoredProject { actors: AuthoredCast[]; rows: AuthoredLine[]; filename: string }
