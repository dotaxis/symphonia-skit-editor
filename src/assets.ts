import { core } from './core';
import type { AudioData, AwbEntry, Texture } from './types';

export interface AnimationFrame { x: number; y: number; duration: number; texture: number }
export interface AnimationChannel { tag: number; parameter: number; frames: AnimationFrame[]; ending: 'loop' | 'hold' }
export interface AnimationSlot { slot: number; flags: number; channels: AnimationChannel[] }
export interface AnimationCatalog { slots: AnimationSlot[]; coordinate_scale: number; ticks_per_second: number }
export interface PortraitAsset { slot: number; name: string; textures: (ImageBitmap | null)[]; animation?: AnimationSlot; missing: string[] }
interface PortraitBundle {
  version: 1;
  names: (string | null)[];
  catalog: AnimationCatalog;
  portraits: Record<string, (string | null)[]>;
  textures: Record<string, { file: string; width: number; height: number }>;
}

/** AFS2 tables are small; audio payloads stay in the selected File until played. */
export async function readAwbIndex(file: File): Promise<AwbEntry[]> {
  const header = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const signature = [65, 70, 83, 50, 1, 4, 2, 0];
  if (header.length !== 16 || signature.some((byte, i) => header[i] !== byte)) throw new Error('Unsupported AWB header');
  const head = new DataView(header.buffer);
  const count = head.getUint32(8, true), alignment = head.getUint16(12, true);
  if (!count || count > 65536 || !alignment || head.getUint16(14, true)) throw new Error('Invalid or encrypted AWB bank');
  const offsetTable = 16 + count * 2, tableEnd = offsetTable + (count + 1) * 4;
  if (tableEnd > file.size || file.size > 0xffffffff) throw new Error('AWB bank size is invalid');
  const table = new DataView(await file.slice(0, tableEnd).arrayBuffer());
  if (table.byteLength !== tableEnd) throw new Error('AWB index is truncated');
  const ids = new Set<number>(), entries: AwbEntry[] = [];
  for (let i = 0; i < count; i++) {
    const id = table.getUint16(16 + i * 2, true), rawStart = table.getUint32(offsetTable + i * 4, true);
    const end = table.getUint32(offsetTable + (i + 1) * 4, true), offset = Math.ceil(rawStart / alignment) * alignment;
    if (ids.has(id) || rawStart < tableEnd || offset >= end || end > file.size) throw new Error('Invalid AWB member bounds or duplicate ID');
    ids.add(id); entries.push({ id, offset, size: end - offset });
  }
  return entries;
}

function japaneseBank(file: File) { return /(^|\/)voice_jp\//i.test(file.webkitRelativePath); }

/** Optional audio has not been connected yet; this is guidance for the UI. */
export class MissingVoiceBankError extends Error {
  constructor(filename: string) {
    super(`Load ${filename} in Voices to preview this line’s audio.`);
    this.name = 'MissingVoiceBankError';
  }
}

/** Files remain browser-owned. Large voice banks are sliced per clip, never copied into project files. */
export class Assets {
  files = new Map<string, File>();
  names: (string | null)[] = [];
  catalog?: AnimationCatalog;
  banks = new Map<number, { file: File; entries: AwbEntry[] }>();
  private portraits = new Map<number, Promise<PortraitAsset>>();
  private textures = new Map<string, Promise<ImageBitmap>>();
  private voices = new Map<number, Promise<AudioData>>();
  private bundle?: PortraitBundle;
  private bundleLoad?: Promise<void>;
  private bundleBase = new URL(`${import.meta.env.BASE_URL}portraits/`, document.baseURI);
  warnings: string[] = [];
  /** The bundled catalog is small; portrait PNGs are requested only when displayed. */
  async loadBundled(): Promise<void> {
    this.bundleLoad ??= (async () => {
      const response = await fetch(new URL('manifest.json', this.bundleBase));
      if (!response.ok) throw new Error(`Could not load bundled portraits (${response.status})`);
      const bundle: PortraitBundle = await response.json();
      if (bundle.version !== 1 || !Array.isArray(bundle.names) || !Array.isArray(bundle.catalog?.slots)
          || !bundle.portraits || !bundle.textures) throw new Error('Unsupported bundled portrait catalog');
      this.bundle = bundle;
      if (!this.names.length) this.names = bundle.names;
      this.catalog ??= bundle.catalog;
      this.portraits.clear();
    })();
    try { await this.bundleLoad; }
    catch (error) { this.bundleLoad = undefined; throw error; }
  }
  async add(files: File[]) {
    this.warnings = [];
    // Index names, retaining a qualified path as well. No file content is uploaded.
    for (const file of files) {
      this.files.set(file.name.toLowerCase(), file);
      this.files.set((file.webkitRelativePath || file.name).toLowerCase(), file);
    }
    for (const file of files) {
      const name = file.name.toLowerCase();
      try {
        if (name === 'skitdata.tosbin') this.names = await core('inspect_assets', 'skitdata', new Uint8Array(await file.arrayBuffer()));
        if (name === 'tos.exe') this.catalog = await core('inspect_assets', 'exe', new Uint8Array(await file.arrayBuffer()));
        const bank = { 'cht_disc_1.awb': 1, 'cht_disc_2.awb': 2, 'cht_common.awb': 3 }[name];
        if (bank) {
          // Prefer the explicit Japanese folder if an imported tree contains both variants.
          const existing = this.banks.get(bank);
          if (existing && japaneseBank(existing.file) && !japaneseBank(file)) continue;
          const entries = await readAwbIndex(file);
          this.banks.set(bank, { file, entries });
        }
      } catch (error) { this.warnings.push(`${file.name}: ${String(error)}`); }
    }
    this.portraits.clear(); this.voices.clear();
    // The stage may still display the prior import during asynchronous loading.
    // Release our references; closing those bitmaps here would invalidate its canvas draws.
    this.textures.clear();
  }
  get count() { return new Set(this.files.values()).size; }
  async portrait(slot: number): Promise<PortraitAsset> {
    if (!this.portraits.has(slot)) this.portraits.set(slot, this.loadPortrait(slot));
    return this.portraits.get(slot)!;
  }
  private async loadPortrait(slot: number) {
    const name = this.names[slot];
    if (!name) throw new Error(`Portrait ${slot} is not in the portrait catalog`);
    const file = this.files.get(name.toLowerCase());
    const entries = file
      ? await core<(string | null)[]>('inspect_assets', 'pac', new Uint8Array(await file.arrayBuffer()))
      : this.bundle?.portraits[name.toLowerCase()];
    if (!entries) throw new Error(`Missing ${name}`);
    const missing: string[] = [];
    const textures = await Promise.all(entries.map(async entry => {
      if (!entry) return null;
      const key = entry.toLowerCase().replace(/\.totexb_d$/, '.totexp_p');
      const source = this.files.get(key);
      const bundled = this.bundle?.textures[key];
      if (!source && !bundled) { missing.push(entry); return null; }
      if (!this.textures.has(key)) this.textures.set(key, (async () => {
        if (source) {
          const texture = await core<Texture>('decode_texture', new Uint8Array(await source.arrayBuffer()));
          return createImageBitmap(new ImageData(new Uint8ClampedArray(texture.rgba), texture.width, texture.height));
        }
        const response = await fetch(new URL(bundled!.file, this.bundleBase));
        if (!response.ok) throw new Error(`Could not load portrait layer ${bundled!.file} (${response.status})`);
        return createImageBitmap(await response.blob());
      })());
      return this.textures.get(key)!;
    }));
    if (!textures[0]) throw new Error(`Portrait ${slot}: missing base texture ${entries[0] ?? '(empty PAC)'}`);
    return { slot, name, textures, animation: this.catalog?.slots[slot], missing };
  }
  async voice(id: number): Promise<AudioData> {
    if (!Number.isInteger(id) || id < 0 || id > 0xffffffff) throw new Error('Invalid packed voice ID');
    // Cache a few recently used clips; long editing sessions must not retain whole banks as PCM.
    const cached = this.voices.get(id);
    if (cached) { this.voices.delete(id); this.voices.set(id, cached); }
    if (!this.voices.has(id)) this.voices.set(id, (async () => {
      const bankId = id >>> 16;
      const bank = this.banks.get(bankId);
      if (!bank) {
        const filename = ({ 1: 'CHT_DISC_1.AWB', 2: 'CHT_DISC_2.AWB', 3: 'CHT_COMMON.AWB' } as Record<number, string>)[bankId];
        if (!filename) throw new Error(`Unsupported voice bank ${bankId}.`);
        throw new MissingVoiceBankError(filename);
      }
      const entry = bank.entries.find(item => item.id === (id & 0xffff));
      if (!entry) throw new Error(`Voice ${id} is missing from the selected bank.`);
      const data = new Uint8Array(await bank.file.slice(entry.offset, entry.offset + entry.size).arrayBuffer());
      return core<AudioData>('decode_audio', data);
    })());
    while (this.voices.size > 8) this.voices.delete(this.voices.keys().next().value!);
    try { return await this.voices.get(id)!; }
    catch (error) { this.voices.delete(id); throw error; }
  }
}

export class VoicePlayer {
  private context?: AudioContext;
  private source?: AudioBufferSourceNode;
  private generation = 0;
  stop() { this.generation++; this.source?.stop(); this.source = undefined; }
  async play(assets: Assets, id: number, offset = 0) {
    this.stop();
    const generation = this.generation;
    this.context ??= new AudioContext();
    await this.context.resume();
    const data = await assets.voice(id);
    if (generation !== this.generation) return;
    const frames = data.pcm.length / data.channels;
    if (offset >= frames / data.sample_rate) return;
    const buffer = this.context.createBuffer(data.channels, frames, data.sample_rate);
    for (let channel = 0; channel < data.channels; channel++) {
      const samples = buffer.getChannelData(channel);
      for (let frame = 0; frame < frames; frame++) samples[frame] = data.pcm[frame * data.channels + channel];
    }
    const source = this.context.createBufferSource();
    source.buffer = buffer; source.connect(this.context.destination);
    source.start(0, Math.max(0, offset)); this.source = source;
  }
}

export function animationFrame(channel: AnimationChannel, seconds: number, talking: boolean) {
  if (!channel.frames.length) return undefined;
  if (channel.tag === 0x7003 && !talking) return channel.frames[0];
  // Use the original PC frame durations for one elapsed-time preview. Native
  // timers poll every two 60 Hz ticks and advance on > duration, discarding overshoot.
  const spans = channel.frames.map(frame => (Math.floor(frame.duration / 2) + 1) * 2);
  const total = spans.reduce((sum, value) => sum + value, 0);
  let tick = Math.floor(Math.max(0, Number.isFinite(seconds) ? seconds : 0) * 60);
  if (channel.ending === 'loop') tick %= total;
  else if (tick >= total) return channel.frames.at(-1);
  for (let i = 0; i < spans.length; i++) { if (tick < spans[i]) return channel.frames[i]; tick -= spans[i]; }
  return channel.frames[0];
}
