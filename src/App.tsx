import { cloneElement, isValidElement, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Assets, MissingVoiceBankError, VoicePlayer } from './assets';
import { core, download, fromBase64, toBase64 } from './core';
import Stage, { type StageActor } from './Stage';
import PortraitPicker from './PortraitPicker';
import PortraitReplacement from './PortraitReplacement';
import { projectStage } from './projection';
import { readProject } from './project';
import { retailPortraitResources, replacePortraitAppearance, replacePortraitInstances, replacePortraitResource } from './retail-portraits';
import { retailStages } from './retail-projection';
import { setAuthoredPosition, setRetailPosition, swapAuthoredPositions, swapRetailPositions } from './staging';
import { actorName, automaticLabel, characterName, sequenceSpeakerNames } from './characters';
import { skitId, skitTitle } from './skit-titles';
import { safeFrames, validateRetailFrames } from './validation';
import { isEncodedCharacter, dialogueLines, effectiveInstructions, effectiveMessages, emptyEdits, newLine, portraits, toAuthored, updateLiteral, updateMessage, visibleText, warningsForText } from './model';
import type { Argument, AuthoredProject, DialogueLine, EditSet, Session, SkitDocument, Token } from './types';

type WorkspaceData = { kind: 'retail'; session: Session } | { kind: 'authored'; project: AuthoredProject };
type Workspace = WorkspaceData & { draftId: string };
type History = { past: Workspace[]; current: Workspace | null; future: Workspace[] };
type PortraitTarget = { actorId?: number; rowId?: string; resourceSlot?: number; spawnPc?: number; selected: number; askScope?: boolean };
const EMPTY: History = { past: [], current: null, future: [] };
const seconds = (ticks: number) => (ticks / 60).toFixed(2);

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  const id = useId();
  return <label className="field" htmlFor={id}><span>{label}</span>{isValidElement(children)
    ? cloneElement(children as React.ReactElement<{id?: string; 'aria-label'?: string}>, { id, 'aria-label': label }) : children}</label>;
}
function NumberField({ label, value, onChange, min, max, disabled = false }: { label: string; value?: number; onChange: (value: number) => void; min?: number; max?: number; disabled?: boolean }) {
  return <Field label={label}><input type="number" value={value ?? ''} disabled={disabled} min={min} max={max} onChange={event => {
    if (event.target.value === '') return;
    const value = Number(event.target.value); if (Number.isFinite(value)) onChange(value);
  }} /></Field>;
}

function RetailMessageEditor({ session, index, advanced = false, onChange }: {
  session: Session; index: number; advanced?: boolean; onChange: (edits: EditSet) => void;
}) {
  const message = session.document.messages[index];
  if (!message) return null;
  const edit = session.edits.messages.find(item => item.index === index);
  const tokens = edit?.tokens ?? message.tokens;
  const omit = edit?.omitEncodedCharacters ?? false;
  return <div className="field"><span>Edited text</span>
    {message.editable && message.tokens.some(isEncodedCharacter) && <>
      <label className="check"><input type="checkbox" checked={!omit} onChange={event => {
        const edits = updateMessage(session.edits, index, tokens);
        onChange({ ...edits, messages: edits.messages.map(item => item.index === index
          ? { ...item, omitEncodedCharacters: !event.target.checked } : item) });
      }} />Preserve original encoded characters</label>
      <p className="hint">Uncheck to remove original encoded characters from this message. Control codes are always preserved.</p>
    </>}
    {tokens.map((token, i) => token.kind === 'protected'
      ? omit && isEncodedCharacter(token) ? null : <code className="control-token" key={i} title={token.hex}>{token.label} · protected</code>
      : <textarea key={`${index}-${i}`} aria-label={`${advanced ? 'Message' : 'Edited'} text ${i+1}`}
          rows={Math.max(2, token.text.split('\n').length+1)} value={token.text} onChange={event => {
            const next = [...tokens]; next[i] = { kind: 'text', text: event.target.value };
            onChange(updateMessage(session.edits, index, next));
          }} />)}
  </div>;
}

export default function App() {
  const [history, setHistory] = useState<History>(EMPTY);
  const workspace = history.current;
  const [selected, setSelected] = useState(0);
  const [selectedActor, setSelectedActor] = useState<number>();
  const [tab, setTab] = useState<'dialogue' | 'stage' | 'script'>('dialogue');
  const [search, setSearch] = useState('');
  const [advancedMessage, setAdvancedMessage] = useState(0);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [validationError, setValidationError] = useState('');
  const [busy, setBusy] = useState(false);
  const [assetsOpen, setAssetsOpen] = useState(false);
  const [conversionOpen, setConversionOpen] = useState(false);
  const [portraitPicker, setPortraitPicker] = useState<PortraitTarget | null>(null);
  const [portraitReplacement, setPortraitReplacement] = useState<{ target: PortraitTarget; slot: number; workspace: Workspace } | null>(null);
  const [selectedResource, setSelectedResource] = useState<number>();
  const [assetRevision, setAssetRevision] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [playSequence, setPlaySequence] = useState(false);
  const [time, setTime] = useState(0);
  const [previewMuted, setPreviewMuted] = useState(false);
  const [dirtyDrafts, setDirtyDrafts] = useState<Set<string>>(() => new Set());
  const unsaved = !!workspace && dirtyDrafts.has(workspace.draftId);
  const hasUnsavedDraft = [...history.past, ...(workspace ? [workspace] : []), ...history.future].some(value => dirtyDrafts.has(value.draftId));
  const assets = useRef(new Assets()).current;
  const player = useRef(new VoicePlayer()).current;
  const fileInput = useRef<HTMLInputElement>(null);
  const assetInput = useRef<HTMLInputElement>(null);
  const opening = useRef(0);

  const session = workspace?.kind === 'retail' ? workspace.session : null;
  const project = workspace?.kind === 'authored' ? workspace.project : null;
  const messages = useMemo(() => session ? effectiveMessages(session) : [], [session]);
  const lines = useMemo(() => session ? dialogueLines(session) : [], [session]);
  const cast = useMemo(() => session ? portraits(session) : [], [session]);
  const retailSnapshots = useMemo(() => session ? retailStages(session, lines) : [], [session, lines]);
  const retailStage = retailSnapshots[selected];
  // Original cue positions remain snap targets even after placements overlap.
  const originalStages = useMemo(() => {
    if (!session) return new Map<string, StageActor[]>();
    const original = { ...session, edits: emptyEdits() }, originalLines = dialogueLines(original);
    const stages = retailStages(original, originalLines);
    return new Map(originalLines.map((line, index) => [line.key, stages[index].actors]));
  }, [session?.document]);
  const portraitResources = useMemo(() => session ? retailPortraitResources(session) : [], [session]);
  const portraitResource = portraitResources.find(resource => resource.slot === selectedResource) ?? portraitResources[0];
  const speakerNames = useMemo(() => project ? sequenceSpeakerNames(project) : lines.map((line, index) => {
    const id = line.speaker?.value;
    if (id === undefined) return 'Text record';
    const actor = retailSnapshots[index]?.actors.find(actor => actor.id === id);
    if (actor) return actor.name;
    const portrait = cast.find(actor => actor.actorId === id);
    return actorName(id, portrait?.args[12]?.value === undefined ? undefined : portrait.resourceId);
  }), [project, lines, cast, retailSnapshots]);
  const line = lines[selected];
  const authoredLine = project?.rows[selected];
  const lineCount = project?.rows.length ?? lines.length;
  const filename = session?.filename ?? project?.filename ?? '';
  const title = skitTitle(filename);
  const displayedTitle = title === undefined ? 'Unknown skit title' : title || 'No English title';
  const currentText = authoredLine?.text ?? (line ? visibleText(messages[line.messageIndex]?.tokens ?? []) : '');
  const currentSpeaker = authoredLine?.speaker ?? line?.speaker?.value;
  const currentVoice = authoredLine ? (authoredLine.voiceEnabled ? authoredLine.voiceId : null) : line?.voice?.value;
  const duration = authoredLine ? authoredLine.durationTicks / 60 : 5;

  function markDraft(id: string | undefined, dirty: boolean) {
    if (!id) return;
    setDirtyDrafts(previous => { const next = new Set(previous); if (dirty) next.add(id); else next.delete(id); return next; });
  }
  function replace(value: WorkspaceData, message = '', dirty = false) {
    opening.current++;
    const current = {...value, draftId: crypto.randomUUID()};
    // Opening another file is undoable, so opening a file keeps the current draft.
    setHistory(previous => ({past: previous.current ? [...previous.past.slice(-79), previous.current] : [], current, future: []})); setSelected(0); setSelectedActor(undefined);
    markDraft(current.draftId, dirty);
    setTime(0); setPlaying(false); setPlaySequence(false); setAdvancedMessage(0); setPortraitPicker(null); setPortraitReplacement(null); setSelectedResource(undefined); player.stop(); setNotice(message); setError(''); setValidationError('');
  }
  function change(action: (value: Workspace) => Workspace) {
    setHistory(previous => {
      if (!previous.current) return previous;
      return { past: [...previous.past.slice(-79), previous.current], current: action(previous.current), future: [] };
    }); markDraft(workspace?.draftId, true);
  }
  function changeProject(action: (value: AuthoredProject) => AuthoredProject) {
    change(value => value.kind === 'authored' ? { ...value, project: action(value.project) } : value);
  }
  function changeRow(patch: Partial<NonNullable<typeof authoredLine>>) {
    changeProject(value => ({ ...value, rows: value.rows.map((row, i) => i === selected ? { ...row, ...patch } : row) }));
  }
  function choosePortrait(textureSlot: number) {
    if (!portraitPicker) return;
    if (portraitPicker.askScope && workspace) {
      if (textureSlot !== portraitPicker.selected) setPortraitReplacement({ target: portraitPicker, slot: textureSlot, workspace });
      setPortraitPicker(null);
      return;
    }
    if (session && portraitPicker.resourceSlot !== undefined) {
      try {
        if (!assets.names[textureSlot]) throw new Error('Choose an available portrait.');
        const edits = replacePortraitResource(session, portraitPicker.resourceSlot, textureSlot);
        change(value => value.kind === 'retail' ? {...value, session: {...value.session, edits}} : value);
        setPortraitPicker(null);
      } catch (error) { setError(String(error)); }
      return;
    }
    const {actorId, rowId} = portraitPicker;
    if (actorId === undefined) return;
    changeProject(value => rowId ? {...value, rows: value.rows.map(row => {
      if (row.id !== rowId) return row;
      const exists = row.stage.some(event => event.actorId === actorId);
      return {...row, stage: exists ? row.stage.map(event => event.actorId === actorId ? {...event, textureSlot} : event)
        : [...row.stage, {actorId, textureSlot}]};
    })} : {...value, actors: value.actors.map(actor => actor.id === actorId ? {...actor, textureSlot} : actor)});
    setPortraitPicker(null);
  }
  function confirmPortraitReplacement(all: boolean) {
    if (!portraitReplacement || portraitReplacement.workspace !== workspace) { setPortraitReplacement(null); return; }
    const { target, slot: textureSlot } = portraitReplacement;
    try {
      if (!assets.names[textureSlot]) throw new Error('Choose an available portrait.');
      if (session && target.spawnPc !== undefined) {
        const proposal = all ? portraitChanges?.all : portraitChanges?.local;
        if (!proposal?.edits) throw new Error(proposal?.reason ?? 'This portrait cannot be replaced.');
        const edits = proposal.edits;
        change(value => value.kind === 'retail' ? {...value, session: {...value.session, edits}} : value);
      } else if (project && target.actorId !== undefined) {
        changeProject(value => all ? {
          ...value,
          actors: value.actors.map(actor => actor.textureSlot === target.selected ? {...actor, textureSlot} : actor),
          rows: value.rows.map(row => ({...row, stage: row.stage.map(event => event.textureSlot === target.selected ? {...event, textureSlot} : event)})),
        } : {...value, rows: value.rows.map(row => row.id !== target.rowId ? row : {...row,
          stage: row.stage.some(event => event.actorId === target.actorId)
            ? row.stage.map(event => event.actorId === target.actorId ? {...event, textureSlot} : event)
            : [...row.stage, {actorId: target.actorId!, textureSlot}],
        })});
      }
      setPortraitReplacement(null); setError('');
    } catch (error) { reportFailure(error); setPortraitReplacement(null); }
  }
  function literal(argument: Argument | undefined, value: number) {
    try {
      if (!session) return;
      const edits = updateLiteral(session.edits, argument, value);
      change(item => item.kind === 'retail' ? { ...item, session: { ...item.session, edits } } : item);
    } catch (error) { setError(String(error)); }
  }
  function changeSpeaker(value: number) {
    if (project) { changeRow({speaker: value}); return; }
    if (!session || !line?.speaker?.editable) return;
    const cues = line.speakerCues.filter(cue => cue.value === line.speaker?.value);
    const edits = cues.reduce((edits, cue) => updateLiteral(edits, cue, value), session.edits);
    // Frame controls belong to this row's selected speaker. Keep their actor
    // target in sync when its activation cues are reassigned.
    edits.insertions = edits.insertions?.map(insertion => {
      if (insertion.beforePc !== (line.speakerPc ?? -2) + 1) return insertion;
      const instructions = [...insertion.instructions];
      for (let i = 0; i + 10 < instructions.length; i += 11) {
        const actor = instructions[i] as {kind: string; value?: number};
        const property = instructions[i + 3] as {kind: string; value?: number};
        if (actor.kind === 'literal' && actor.value === line.speaker?.value && property.kind === 'literal' && [64,65].includes(property.value ?? -1)) {
          instructions[i] = {...actor, value} as typeof instructions[number];
        }
      }
      return {...insertion, instructions};
    });
    change(workspace => workspace.kind === 'retail' ? {...workspace, session: {...workspace.session, edits}} : workspace);
  }
  function undo() { if (history.past.at(-1)?.draftId === workspace?.draftId) markDraft(workspace?.draftId, true); setHistory(value => value.past.length ? { past: value.past.slice(0, -1), current: value.past.at(-1)!, future: [value.current!, ...value.future] } : value); setPortraitPicker(null); setPortraitReplacement(null); }
  function redo() { if (history.future[0]?.draftId === workspace?.draftId) markDraft(workspace?.draftId, true); setHistory(value => value.future.length ? { past: [...value.past, value.current!], current: value.future[0], future: value.future.slice(1) } : value); setPortraitPicker(null); setPortraitReplacement(null); }
  function reportFailure(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof MissingVoiceBankError) setNotice(message);
    else setError(message);
  }
  async function task(action: () => Promise<void>) {
    setBusy(true); setError('');
    try { await action(); } catch (error) { reportFailure(error); }
    finally { setBusy(false); }
  }
  async function open(file: File) {
    const generation = ++opening.current;
    await task(async () => {
      if (file.size > 16 * 1024 * 1024) throw new Error('Skit and project files must be smaller than 16 MB.');
      if (/\.json$/i.test(file.name)) {
        const saved = readProject(JSON.parse(await file.text()));
        if (saved.kind === 'retail') {
          const original = fromBase64(saved.original);
          const document = await core<SkitDocument>('parse_skit', original);
          if (generation === opening.current) replace({ kind: 'retail', session: { filename: saved.filename, original, document, edits: saved.edits } }, 'Project opened.');
        } else {
          // Drafts can contain text or values that need correction before export.
          // Validate the UI shape on open; the live compiler gates binary export.
          if (generation === opening.current) replace({ kind: 'authored', project: saved.project }, 'Sequence project opened.');
        }
      } else {
        const original = new Uint8Array(await file.arrayBuffer());
        const document = await core<SkitDocument>('parse_skit', original);
        if (generation === opening.current) replace({ kind: 'retail', session: { filename: file.name, original, document, edits: emptyEdits() } }, `Opened ${file.name}. Original bytes are preserved.`);
      }
    });
  }
  function authorSpec(value: AuthoredProject) {
    if (assets.names.length) {
      const slots = [...value.actors.map(actor => actor.textureSlot), ...value.rows.flatMap(row => row.stage.flatMap(event => event.textureSlot === undefined ? [] : [event.textureSlot]))];
      for (const slot of slots) if (!assets.names[slot]) throw new Error(`Portrait ${slot} is empty in the portrait catalog. Choose an available portrait.`);
    }
    return { actors: value.actors.map(({name: _name, ...actor}) => actor), rows: value.rows.map(({id: _id, ...row}) => row), animationFrames: assets.catalog?.slots.map(slot => ({ textureSlot: slot.slot,
      eyeFrames: slot.channels.find(channel => channel.tag === 0x7000)?.frames.length ?? 0,
      mouthFrames: slot.channels.find(channel => channel.tag === 0x7003)?.frames.length ?? 0 })) };
  }
  async function exportSkit() {
    if (!workspace) return;
    await task(async () => {
      if (!/^FC_[BCUW]\d{3}\.SKP$/i.test(filename)) throw new Error('Choose an existing slot filename such as FC_W001.SKP before exporting.');
      if (session) validateRetailFrames(session, assets.catalog);
      const output = session ? await core<Uint8Array>('compile_skit', session.original, JSON.stringify(session.edits))
        : await core<Uint8Array>('author_skit', JSON.stringify(authorSpec(project!)));
      await core('parse_skit', output);
      download(filename, output); setNotice(`Exported ${filename} · ${output.length.toLocaleString()} bytes. Install it with your existing mod workflow.`);
    });
  }
  function saveProject() {
    if (!workspace) return;
    const content = session ? { kind: 'retail', filename, original: toBase64(session.original), edits: session.edits }
      : { kind: 'authored', project };
    download(filename.replace(/\.skp$/i, '') + '.skit.json', JSON.stringify({ format: 'tos-skit-project', version: 1, ...content,
      assets: { filenames: [...new Set([...assets.files.values()].map(file => file.name))] } }, null, 2), 'application/json');
    markDraft(workspace.draftId, false); setNotice('Project saved.');
  }
  async function loadVoices(files: File[]) {
    await task(async () => {
      if (!files.length || files.some(file => !/^CHT_(?:COMMON|DISC_1|DISC_2)\.AWB$/i.test(file.name))) {
        throw new Error('Select CHT_COMMON.AWB, CHT_DISC_1.AWB, or CHT_DISC_2.AWB from VOICE_JP.');
      }
      await assets.add(files); setAssetRevision(value => value + 1);
      setNotice(`Loaded ${assets.banks.size} voice banks.`);
      if (assets.warnings.length) setError(assets.warnings.join('\n'));
    });
  }
  useEffect(() => {
    let active = true;
    assets.loadBundled().then(() => { if (active) setAssetRevision(value => value + 1); })
      .catch(error => { if (active) setError(`Could not load bundled portraits: ${String(error)}`); });
    return () => { active = false; };
  }, [assets]);
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => { if (hasUnsavedDraft) event.preventDefault(); };
    window.addEventListener('beforeunload', handler); return () => window.removeEventListener('beforeunload', handler);
  }, [hasUnsavedDraft]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (portraitPicker || portraitReplacement) return;
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() === 's') { event.preventDefault(); saveProject(); }
      if (event.key.toLowerCase() === 'z' && !['INPUT', 'TEXTAREA'].includes((event.target as HTMLElement)?.tagName)) {
        event.preventDefault(); event.shiftKey ? redo() : undo();
      }
    };
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler);
  });
  useEffect(() => {
    let active = true;
    const timer = setTimeout(async () => {
      if (!workspace) return;
      try {
        if (session) { validateRetailFrames(session, assets.catalog); await core('compile_skit', session.original, JSON.stringify(session.edits)); }
        else if (project?.rows.length) await core('author_skit', JSON.stringify(authorSpec(project)));
        if (active) setValidationError('');
      } catch (error) { if (active) setValidationError(String(error)); }
    }, 350);
    return () => { active = false; clearTimeout(timer); };
  }, [workspace, assetRevision]);
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now(); const delta = (now - last) / 1000; last = now;
      setTime(value => {
        const next = value + delta;
        if (next >= duration) {
          if (playSequence && project && selected + 1 < project.rows.length) { setSelected(selected + 1); return 0; }
          setPlaying(false); setPlaySequence(false); return duration;
        }
        return next;
      });
    }, 1000 / 60);
    return () => clearInterval(timer);
  }, [playing, duration, selected, playSequence, project]);
  useEffect(() => {
    let active = true;
    if (playing && !previewMuted && currentVoice !== null && currentVoice !== undefined && currentVoice > 0) {
      player.play(assets, currentVoice, time).catch(error => { if (active) reportFailure(error); });
    } else player.stop();
    return () => { active = false; player.stop(); };
    // Start/stop on transitions, not every animation tick.
  }, [playing, selected, previewMuted, currentVoice, assetRevision]);
  function chooseLine(index: number) { setSelected(index); setTime(0); setPlaying(false); setPlaySequence(false); player.stop(); }
  useEffect(() => { if (selected >= lineCount) setSelected(Math.max(0, lineCount - 1)); }, [selected, lineCount]);

  const stageActors = useMemo<StageActor[]>(() => {
    if (project) return projectStage(project, selected, time);
    return retailStage?.actors ?? [];
  }, [project, selected, time, retailStage]);
  const activeActor = stageActors.find(actor => actor.id === selectedActor) ?? stageActors[0];
  const actorRecord = retailStage?.actors.find(actor => actor.id === activeActor?.id);
  function selectStageActor(id: number) {
    setSelectedActor(id); setPlaying(false); setPlaySequence(false); player.stop();
  }
  function openPortrait(id: number) {
    const actor = stageActors.find(actor => actor.id === id);
    if (!actor || actor.slot < 0) return;
    const source = retailStage?.actors.find(actor => actor.id === id);
    if (session && source?.spawnPc === undefined) {
      setNotice('This preview portrait could not be linked to its script placement.'); return;
    }
    setSelectedActor(id); setPlaying(false); setPlaySequence(false); player.stop();
    setPortraitPicker({ actorId: id, rowId: authoredLine?.id, spawnPc: source?.spawnPc, selected: actor.slot, askScope: true });
  }
  const portraitChanges = useMemo(() => {
    if (!portraitReplacement || !session || portraitReplacement.target.spawnPc === undefined) return undefined;
    function prepare(all: boolean): { edits?: EditSet; reason?: string } {
      try { return { edits: (all ? replacePortraitInstances : replacePortraitAppearance)(session!, portraitReplacement!.target.spawnPc!, portraitReplacement!.slot) }; }
      catch (error) { return { reason: error instanceof Error ? error.message : String(error) }; }
    }
    return { local: prepare(false), all: prepare(true) };
  }, [portraitReplacement, session]);
  function hasStagedPosition(id: number) {
    return project?.rows.slice(0, selected + 1).some(row => row.stage.some(event => event.actorId === id && (event.x !== undefined || event.y !== undefined))) ?? false;
  }
  function moveActor(id: number, x: number, y: number) {
    if (project) {
      if (authoredLine && hasStagedPosition(id)) {
        try {
          const moved = setAuthoredPosition(project, selected, id, x, y);
          if (moved !== project) changeProject(() => moved);
        } catch (error) { reportFailure(error); }
      } else changeProject(value => ({ ...value, actors: value.actors.map(actor => actor.id === id ? { ...actor, x, y } : actor) }));
    } else if (session) {
      try {
        const edits = setRetailPosition(session, retailStage?.actors ?? [], id, x, y);
        if (edits !== session.edits) change(value => value.kind === 'retail' ? { ...value, session: { ...value.session, edits } } : value);
      } catch (error) { reportFailure(error); }
    }
  }
  function positionReason(id: number, x: number, y: number, swapWith?: number) {
    try {
      if (project) {
        if (swapWith !== undefined) swapAuthoredPositions(project, selected, stageActors, id, swapWith);
        else setAuthoredPosition(project, selected, id, x, y);
      } else if (session) {
        if (swapWith !== undefined) swapRetailPositions(session, retailStage?.actors ?? [], id, swapWith);
        else setRetailPosition(session, retailStage?.actors ?? [], id, x, y);
      }
      return undefined;
    } catch (error) { return error instanceof Error ? error.message : String(error); }
  }
  function placePortrait(id: number, x: number, y: number, swapWith?: number) {
    if (tab !== 'stage') return;
    const actor = stageActors.find(actor => actor.id === id);
    if (!actor || actor.x === x && actor.y === y) return;
    try {
      if (project) {
        const moved = swapWith === undefined ? setAuthoredPosition(project, selected, id, x, y)
          : swapAuthoredPositions(project, selected, stageActors, id, swapWith);
        if (moved !== project) changeProject(() => moved);
      } else if (session) {
        const edits = swapWith === undefined ? setRetailPosition(session, retailStage?.actors ?? [], id, x, y)
          : swapRetailPositions(session, retailStage?.actors ?? [], id, swapWith);
        if (edits !== session.edits) change(value => value.kind === 'retail' ? { ...value, session: { ...value.session, edits } } : value);
      }
    } catch (error) { reportFailure(error); }
  }
  function expressionFrame(channel: 'eyeFrame' | 'mouthFrame', frame: number) {
    if (project) { changeRow({ [channel]: frame }); return; }
    if (!session || !line?.speakerPc || currentSpeaker === undefined) return;
    const beforePc = line.speakerPc + 1;
    const property = channel === 'eyeFrame' ? 64 : 65;
    const instructions = [currentSpeaker, property, frame].flatMap(value => [
      { kind: 'literal', value }, { kind: 'calculate', opcode: 0 }, { kind: 'argument' },
    ]).concat([{ kind: 'native', opcode: 0x1d }, { kind: 'calculate', opcode: 0 }] as never);
    change(value => {
      if (value.kind !== 'retail') return value;
      const existing = value.session.edits.insertions ?? [];
      // One insertion holds both optional frame overrides at the boundary after the speaker command.
      const prior = existing.find(item => item.beforePc === beforePc)?.instructions ?? [];
      const blocks = prior.length ? Array.from({ length: Math.ceil(prior.length / 11) }, (_, i) => prior.slice(i * 11, (i + 1) * 11)) : [];
      const keep = blocks.filter(block => (block[3] as {value?:number})?.value !== property).flat();
      return { ...value, session: { ...value.session, edits: { ...value.session.edits,
        insertions: [...existing.filter(item => item.beforePc !== beforePc), { beforePc, instructions: [...keep, ...(frame === -2 ? [] : instructions)] }] } } };
    });
  }
  function currentFrame(channel: 'eyeFrame' | 'mouthFrame') {
    if (authoredLine) return authoredLine[channel];
    const property = channel === 'eyeFrame' ? 64 : 65;
    const insertion = session?.edits.insertions?.find(item => item.beforePc === (line?.speakerPc ?? -2) + 1);
    const instructions = insertion?.instructions as {value?:number}[] | undefined;
    for (let i=0; instructions && i<instructions.length; i+=11) if (instructions[i+3]?.value === property) return instructions[i+6]?.value ?? -1;
    return -2;
  }
  const speakingActor = stageActors.find(actor => actor.id === currentSpeaker);
  const animation = speakingActor ? assets.catalog?.slots[speakingActor.animationSlot ?? speakingActor.slot] : undefined;
  const retailFrameBounds = session && currentSpeaker !== undefined ? safeFrames(session, currentSpeaker, assets.catalog) : undefined;
  const textWarnings = warningsForText(currentText.replace(/⟦[^⟧]*⟧/g, ''));

  return <div className="app" onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }} onDrop={event => {
    event.preventDefault(); const file = event.dataTransfer.files[0]; if (file) /\.(skp|json)$/i.test(file.name) ? open(file) : loadVoices([...event.dataTransfer.files]);
  }}>
    <header className="topbar">
      <div className="tool-title">TOS Skit Editor <span>PC / Steam</span></div>
      <div className="document-name">{workspace ? <><span className="status-dot" /><div className="document-identity"><h1 className={`skit-title${title ? '' : ' untitled'}`} title="Original English title for this skit slot">{displayedTitle}</h1><span className="document-filename" title={filename}>{filename || 'No slot selected'}</span></div>{unsaved && <span className="dirty">Edited</span>}</> : <span>No file open</span>}</div>
      <div className="header-actions"><button onClick={() => setAssetsOpen(true)}>Voices{assets.banks.size ? ` (${assets.banks.size})` : ''}</button><button onClick={() => fileInput.current?.click()} disabled={busy}>Open skit</button>
        {workspace && <button className="primary" disabled={busy || !!validationError} onClick={exportSkit}>Export SKP</button>}</div>
    </header>
    <input ref={fileInput} type="file" accept=".skp,.json" hidden onChange={event => { const file = event.target.files?.[0]; if (file) open(file); event.target.value = ''; }} />
    <input ref={assetInput} type="file" accept=".awb" multiple hidden onChange={event => { if (event.target.files) loadVoices([...event.target.files]); event.target.value = ''; }} />
    {(error || validationError) && <div className="notice error" role="alert"><span>{error || validationError}</span><button aria-label="Dismiss error" onClick={() => setError('')}>×</button></div>}
    {notice && !error && <div className="notice" role="status"><span>{notice}</span><button aria-label="Dismiss notice" onClick={() => setNotice('')}>×</button></div>}
    {!workspace ? <main className="empty-workspace">
      <section className="file-prompt"><h1>No skit open</h1><p>Open a PC skit (<code>FC_*.SKP</code>) or a saved editor project (<code>.skit.json</code>).</p>
        <button onClick={() => fileInput.current?.click()} disabled={busy}>Open file…</button><span className="drop-hint">or drop a file here</span>
      </section>
      <dl className="resource-summary"><div><dt>Portraits</dt><dd>{assets.catalog ? 'Included, with facial animation data.' : 'Loading bundled portraits…'}</dd></div>
        <div><dt>Voice preview</dt><dd>{assets.banks.size ? `${assets.banks.size} Japanese voice banks loaded.` : 'Optional. Load Japanese CHT voice banks using Voices.'}</dd></div>
        <div><dt>Files</dt><dd>Edits stay in the browser until you save a project or export an SKP.</dd></div></dl>
    </main> : <>
      <div className="workspace-toolbar"><div className="tabs">{(['dialogue','stage','script'] as const).map(value => <button className={tab===value?'active':''} key={value} onClick={() => setTab(value)}>{value==='dialogue'?'Dialogue':value==='stage'?'Cast & staging':'Script details'}</button>)}</div><div className="toolbar-actions"><button title="Undo" aria-label="Undo" disabled={!history.past.length} onClick={undo}>↶</button><button title="Redo" aria-label="Redo" disabled={!history.future.length} onClick={redo}>↷</button><span className="divider" /><button onClick={saveProject}>Save project</button></div></div>
      <main className="workspace">
        <section className="editor-pane">
          {tab === 'dialogue' && <>
            <div className="pane-heading"><div><h2>Dialogue <span>{lineCount}</span></h2></div>{project && <button className="small" onClick={() => { changeProject(value => ({...value,rows:[...value.rows,newLine(value.actors[0]?.id)]})); chooseLine(project.rows.length); }}>+ Add line</button>}</div>
            <div className="search-box"><span>⌕</span><input aria-label="Search dialogue" placeholder="Find a line…" value={search} onChange={event => setSearch(event.target.value)} /><kbd>TEXT</kbd></div>
            <div className="line-list" aria-label="Dialogue lines">
              {(project ? project.rows.map((row,i) => ({key:row.id,text:row.text,speaker:row.speaker,index:i})) : lines.map((row,i) => ({key:row.key,text:visibleText(messages[row.messageIndex]?.tokens??[]),speaker:row.speaker?.value,index:i}))).filter(row => row.text.toLowerCase().includes(search.toLowerCase())).map(row => <button className={`line-row ${selected===row.index?'selected':''}`} key={row.key} onClick={() => chooseLine(row.index)}><span className="line-number">{String(row.index+1).padStart(2,'0')}</span><span className="line-content"><b>{speakerNames[row.index]}</b><span>{row.text||'(empty line)'}</span></span><span className="line-arrow">›</span></button>)}
              {!lineCount && <div className="empty-state">No recognized dialogue calls in this file. Its bytes can still be preserved and exported.</div>}
            </div>
            {(line || authoredLine) && <div className="line-editor">
              <div className="section-label"><span>LINE {String(selected+1).padStart(2,'0')}</span>{project && <div className="compact-actions"><button title="Move line up" aria-label="Move line up" disabled={!selected} onClick={() => { changeProject(value => { const rows=[...value.rows]; [rows[selected-1],rows[selected]]=[rows[selected],rows[selected-1]]; return {...value,rows}; }); chooseLine(selected-1); }}>↑</button><button title="Move line down" aria-label="Move line down" disabled={selected===project.rows.length-1} onClick={() => { changeProject(value => { const rows=[...value.rows]; [rows[selected+1],rows[selected]]=[rows[selected],rows[selected+1]]; return {...value,rows}; }); chooseLine(selected+1); }}>↓</button><button onClick={() => { changeProject(value => { const rows=[...value.rows]; rows.splice(selected+1,0,{...structuredClone(rows[selected]),id:crypto.randomUUID()}); return {...value,rows}; }); chooseLine(selected+1); }}>Duplicate</button><button onClick={() => { changeProject(value=>({...value,rows:value.rows.filter((_,i)=>i!==selected)})); chooseLine(Math.max(0,selected-1)); }}>Delete</button></div>}</div>
              {session && line && <div className="original-text"><span>ORIGINAL</span><p>{visibleText(session.document.messages[line.messageIndex]?.tokens??[])}</p></div>}
              {authoredLine ? <Field label="Edited text"><textarea aria-label="Edited text" rows={4} value={authoredLine.text} onChange={event=>changeRow({text:event.target.value})} placeholder="Dialogue text" /></Field>
                : session && line && <RetailMessageEditor session={session} index={line.messageIndex} onChange={edits=>change(value=>value.kind==='retail'?{...value,session:{...value.session,edits}}:value)} />}
              <div className="text-meta"><span>{currentText.length} characters</span><span>{project?'Exact duration below':'Control expressions are protected'}</span></div>
              {textWarnings.map(warning=><p className="inline-warning" key={warning}>{warning}</p>)}
              <div className="form-grid"><Field label="Speaking character"><select value={currentSpeaker??''} disabled={!!session && (!session.document.codeEditable || !line?.speaker?.editable)} onChange={event=>changeSpeaker(Number(event.target.value))}>{!stageActors.some(actor=>actor.id===currentSpeaker)&&<option value={currentSpeaker??''}>{currentSpeaker===undefined?'Unbound':actorName(currentSpeaker)}</option>}{stageActors.map(actor=><option key={actor.id} value={actor.id}>{actor.name}{stageActors.some(other=>other.id!==actor.id && other.name===actor.name)?` (actor ${actor.id})`:null}</option>)}</select></Field>
                {authoredLine ? <NumberField label="Duration (60 Hz ticks)" value={authoredLine.durationTicks} min={1} max={65535} onChange={durationTicks=>changeRow({durationTicks})} />:<NumberField label="Voice milestone (original value)" value={line?.timing?.value} disabled={!session?.document.codeEditable||!line?.timing?.editable} onChange={value=>literal(line?.timing,value)} />}</div>
              {line?.multiSpeaker && <p className="hint">This line activates more than one character. Changing the selected speaker updates that character’s matching cues and keeps the other speakers.</p>}
              {authoredLine && speakingActor && <button disabled={!assets.names.length} onClick={()=>openPortrait(speakingActor.id)}>Choose portrait expression</button>}
              <div className="form-grid">{(['eyeFrame','mouthFrame'] as const).map((channel,index)=><Field key={channel} label={index?'Mouth animation':'Eye animation'}><select value={currentFrame(channel)} disabled={!animation || (!!session && (!line?.speakerPc || !session.document.codeEditable || !retailFrameBounds))} onChange={event=>expressionFrame(channel,Number(event.target.value))}>{session && <option value={-2}>Original script</option>}<option value={-1}>Automatic</option>{animation?.channels.find(item=>item.tag===(index?0x7003:0x7000))?.frames.slice(0,session?(index?retailFrameBounds?.mouth:retailFrameBounds?.eye):undefined).map((_,i)=><option key={i} value={i}>Hold frame {i+1}</option>)}</select></Field>)}</div>
              {session && <p className="hint">Frame overrides persist until a later override or portrait replacement. Available frames are limited to those safe for every known portrait this actor uses.</p>}<div className="voice-section"><div><span className="section-label">JAPANESE VOICE</span>{authoredLine && <label className="check"><input type="checkbox" checked={authoredLine.voiceEnabled} onChange={event=>changeRow({voiceEnabled:event.target.checked})} /> Enabled in game</label>}</div>
                <div className="form-grid"><NumberField label="Voice ID (packed bank + entry)" value={authoredLine?.voiceId??line?.voice?.value} disabled={!!session} min={0} onChange={voiceId=>changeRow({voiceId})} /><button disabled={!currentVoice||!assets.banks.size} onClick={()=>task(async()=>{await player.play(assets,currentVoice!);setNotice('Playing Japanese voice.');})}>▷ Listen</button></div>
                {project ? <button className="text-button" disabled={!authoredLine?.voiceId||!assets.banks.size} onClick={()=>task(async()=>{const audio=await assets.voice(authoredLine!.voiceId!);changeRow({durationTicks:Math.ceil(audio.pcm.length/audio.channels/audio.sample_rate*60)});})}>Fit duration to voice</button>:<p className="hint">Original voice cues and their synchronized waits are preserved. Sequence editing under Script details allows voice disabling and independent line durations.</p>}
              </div>
            </div>}
          </>}
          {tab === 'stage' && <>
            <div className="pane-heading"><div><h2>Cast <span>{stageActors.length}</span></h2></div>{project && <button disabled={project.actors.length>=31} onClick={()=>changeProject(value=>{const id=Math.max(0,...value.actors.map(actor=>actor.id))+1;return {...value,actors:[...value.actors,{id,name:`Character ${id}`,textureSlot:0,x:320,y:200,scalePercent:100,rotation:0,alpha:255}]};})}>+ Add character</button>}</div>
            <div className="cast-list">{stageActors.map(actor=><button key={actor.id} className={activeActor?.id===actor.id?'selected':''} onClick={()=>selectStageActor(actor.id)}><span className="avatar">{actor.id}</span><span><b>{actor.name}</b><small>Portrait {actor.slot}</small></span></button>)}</div>
            {session && portraitResource && <div className="retail-resources"><Field label="Script portrait resource"><select value={portraitResource.slot} onChange={event=>setSelectedResource(Number(event.target.value))}>{portraitResources.map(resource=><option key={resource.slot} value={resource.slot}>{characterName(resource.currentSlot) ?? 'Unknown character'} · {resource.slot === resource.currentSlot ? `Portrait ${resource.slot}` : `Portrait ${resource.slot} → ${resource.currentSlot}`} · {assets.names[resource.currentSlot] ?? 'unknown'} · {resource.spawnCount} uses</option>)}</select></Field><button disabled={!assets.names.length || !portraitResource.editable} title={portraitResource.reason} onClick={()=>setPortraitPicker({resourceSlot:portraitResource.slot,selected:portraitResource.currentSlot})}>Browse portraits</button><p className="hint">Replaces this portrait resource everywhere it is used in this skit. Existing timing and movement are preserved.</p>{portraitResource.reason && <p className="inline-warning">{portraitResource.reason}</p>}</div>}
            {activeActor && <div className="line-editor"><span className="section-label">{project&&!hasStagedPosition(activeActor.id)?'INITIAL ARRANGEMENT':'PORTRAIT AT SELECTED LINE'}</span><button disabled={!assets.names.length || activeActor.slot < 0} onClick={()=>openPortrait(activeActor.id)}>Replace portrait</button>
              {project && <Field label="Character label"><input value={automaticLabel(activeActor.id,project.actors.find(actor=>actor.id===activeActor.id)?.name)?'':project.actors.find(actor=>actor.id===activeActor.id)?.name??''} placeholder={characterName(activeActor.slot) ?? actorName(activeActor.id)} title="Leave blank to use the portrait’s character name." onChange={event=>changeProject(value=>({...value,actors:value.actors.map(actor=>actor.id===activeActor.id?{...actor,name:event.target.value}:actor)}))}/></Field>}
              <div className="form-grid"><NumberField label="X position" value={activeActor.x} disabled={!!session&&(!session.document.codeEditable||!actorRecord?.xArgument?.editable)} onChange={x=>moveActor(activeActor.id,x,activeActor.y)}/><NumberField label="Y position" value={activeActor.y} disabled={!!session&&(!session.document.codeEditable||!actorRecord?.yArgument?.editable)} onChange={y=>moveActor(activeActor.id,activeActor.x,y)}/></div>
              {project && <><Field label="Portrait / expression resource"><select value={project.actors.find(actor=>actor.id===activeActor.id)?.textureSlot??0} onChange={event=>changeProject(value=>({...value,actors:value.actors.map(actor=>actor.id===activeActor.id?{...actor,textureSlot:Number(event.target.value)}:actor)}))}>{assets.names.length?assets.names.map((name,i)=>name&&<option key={i} value={i}>{characterName(i) ?? 'Unknown character'} · {i} · {name}</option>):Array.from({length:222},(_,i)=><option key={i} value={i}>Portrait {i}</option>)}</select></Field><button disabled={!assets.names.length} onClick={()=>setPortraitPicker({actorId:activeActor.id,selected:project.actors.find(actor=>actor.id===activeActor.id)?.textureSlot??0})}>Browse portraits</button><div className="form-grid"><NumberField label="Scale (%)" value={project.actors.find(actor=>actor.id===activeActor.id)?.scalePercent} min={1} max={400} onChange={scalePercent=>changeProject(value=>({...value,actors:value.actors.map(actor=>actor.id===activeActor.id?{...actor,scalePercent}:actor)}))}/><NumberField label="Rotation (degrees)" value={project.actors.find(actor=>actor.id===activeActor.id)?.rotation} onChange={rotation=>changeProject(value=>({...value,actors:value.actors.map(actor=>actor.id===activeActor.id?{...actor,rotation}:actor)}))}/></div>
                {authoredLine && <div className="stage-events"><span className="section-label">AT LINE {selected+1}</span><p className="hint">Add a movement or appearance change before this line starts.</p><button disabled={authoredLine.stage.some(event=>event.actorId===activeActor.id)} onClick={()=>changeRow({stage:[...authoredLine.stage,{actorId:activeActor.id,x:activeActor.x,y:activeActor.y,movementTicks:30}]})}>+ Stage event</button>{authoredLine.stage.map((event,i)=><div className="stage-event" key={i}><div className="section-label">{stageActors.find(actor=>actor.id===event.actorId)?.name ?? actorName(event.actorId)}<button onClick={()=>changeRow({stage:authoredLine.stage.filter((_,j)=>i!==j)})}>Remove</button></div><div className="form-grid">{(['x','y','movementTicks','scalePercent','textureSlot','rotation','alpha','fadeTicks'] as const).map(key=><NumberField key={key} label={{x:'X',y:'Y',movementTicks:'Move ticks',scalePercent:'Scale %',textureSlot:'Portrait ID',rotation:'Rotation',alpha:'Opacity 0–255',fadeTicks:'Fade ticks'}[key]} value={event[key]} onChange={value=>changeRow({stage:authoredLine.stage.map((item,j)=>j===i?{...item,[key]:value}:item)})}/>)}</div><label className="check"><input type="checkbox" checked={event.visible!==false} onChange={e=>changeRow({stage:authoredLine.stage.map((item,j)=>j===i?{...item,visible:e.target.checked}:item)})}/>Visible</label></div>)}</div>}</>}
              {project && <button disabled={project.actors.length<=1 || project.rows.some(row=>row.speaker===activeActor.id || row.stage.some(event=>event.actorId===activeActor.id))} title="Assign this character’s dialogue and stage events to another character before removing it." onClick={()=>{changeProject(value=>({...value,actors:value.actors.filter(actor=>actor.id!==activeActor.id)}));setSelectedActor(undefined);}}>Remove character</button>}<p className="hint">Drag to a standard position, including an empty one, or enter coordinates above. Hold Shift while dragging onto another portrait to swap positions. Select a character in the cast list to move it out of an overlap. Each drag is one undo step; later scripted placements remain separate.</p>
            </div>}
          </>}
          {tab==='script'&&<div className="script-details"><div className="pane-heading"><div><h2>Script details</h2></div></div><Field label="Existing skit slot filename"><input value={filename} onChange={event=>change(value=>value.kind==='retail'?{...value,session:{...value.session,filename:event.target.value}}:{...value,project:{...value.project,filename:event.target.value}})}/></Field><p className="hint">A custom filename alone does not register a new skit. Choose the filename of a slot your mod replaces.</p><Field label="Skit ID"><input readOnly value={skitId(filename) ?? 'Unknown skit ID'} /></Field><p className="hint">Use this ID in the test maps’ skit selector.</p><Field label="Original slot title"><input readOnly value={displayedTitle} /></Field><p className="hint">The original English title is looked up by slot filename. Menu titles are stored separately in the game’s text archive; exporting an SKP does not change them.</p><div className="details-grid"><div><span>Format</span><b>PC / little endian</b></div><div><span>Mode</span><b>{project?'Authored sequence':'Preserved retail script'}</b></div><div><span>Source messages</span><b>{session?.document.messages.length??project?.rows.length}</b></div><div><span>Core</span><b>Rust · WebAssembly</b></div></div>{session?.document.diagnostics.map((diagnostic,i)=><p className="inline-warning" key={i}>{diagnostic.message}</p>)}{session && <details className="all-messages"><summary>Edit all message records</summary><Field label="Message record"><select value={advancedMessage} onChange={event=>setAdvancedMessage(Number(event.target.value))}>{messages.map(message=><option key={message.index} value={message.index}>{message.index} · {visibleText(message.tokens).slice(0,60)||'(empty)'}</option>)}</select></Field><p className="hint">Includes every message stored in this SKP, including text without a recognized speaker. Control codes remain unchanged.</p><RetailMessageEditor session={session} index={advancedMessage} advanced onChange={edits=>change(value=>value.kind==='retail'?{...value,session:{...value.session,edits}}:value)} /></details>}<p className="hint">Structural and format validation runs before export. In-game playback remains the final check for staging, text fit, and timing.</p>{session&&<details><summary>Sequence editing</summary><p className="hint">For larger changes to this skit: add, remove, or reorder lines, set durations, and edit movement. Rebuilding as a sequence replaces the original script flow.</p><button onClick={()=>setConversionOpen(true)}>Edit as sequence</button></details>}{session&&<details><summary>Inspect native instructions</summary><div className="instruction-list">{effectiveInstructions(session).filter(op=>op.nativeOpcode!==undefined).map(op=><div key={op.pc}><code>{op.pc.toString(16).padStart(4,'0')}</code><code>{`native ${op.nativeOpcode!.toString(16).padStart(2,'0')}`}</code><span>{op.arguments?.map(arg=>arg.value??'computed').join(', ')}</span></div>)}</div></details>}</div>}
        </section>
        <section className="preview-pane"><div className="preview-heading"><div><h2>Preview</h2></div></div>
          <Stage assets={assets} assetRevision={assetRevision} actors={stageActors} originalActors={line ? originalStages.get(line.key) : undefined} speaker={time < duration ? currentSpeaker : undefined} text={currentText} seconds={time} selected={selectedActor} onSelect={selectStageActor} onReplace={tab==='stage'?openPortrait:undefined} onPlace={tab==='stage'?placePortrait:undefined} positionReason={positionReason}/>
          <div className="transport"><div>{project && <button aria-label="Play whole skit" disabled={!lineCount} onClick={()=>{setSelected(0);setTime(0);setPlaySequence(true);setPlaying(true);}}>Play skit</button>}<button aria-label="Previous line" disabled={selected===0} onClick={()=>chooseLine(selected-1)}>⏮</button><button className="play-button" aria-label={playing?'Pause preview':'Play preview'} disabled={!lineCount} onClick={()=>{if(time>=duration)setTime(0);setPlaying(value=>!value);}}>{playing?'Ⅱ':'▶'}</button><button aria-label="Next line" disabled={selected>=lineCount-1} onClick={()=>chooseLine(selected+1)}>⏭</button><span className="time-display">{time.toFixed(2)}<i>/</i>{duration.toFixed(2)} s</span></div><label className="check"><input type="checkbox" checked={previewMuted} onChange={event=>setPreviewMuted(event.target.checked)}/>Mute preview</label></div>
          <div className="timeline"><div className="timeline-label"><span>{project?'LINE TIMELINE':'SELECTED LINE PREVIEW'}</span><span>{project?`${seconds(authoredLine?.durationTicks??0)} seconds`:'5 s audition · original waits preserved'}</span></div><input className="scrubber" aria-label="Preview playhead" type="range" min={0} max={Math.max(duration,0.1)} step={1/60} value={Math.min(time,duration)} onChange={event=>{setPlaying(false);setTime(Number(event.target.value));}}/><div className="timeline-lanes"><div><span>Text</span><div className="track text-track" style={{width:'100%'}}>{currentText.slice(0,70)||'Select a line'}</div></div><div><span>Voice</span><div className={`track voice-track ${!currentVoice?'silent':''}`} style={{width:currentVoice?'82%':'100%'}}>{currentVoice?`Japanese · ${currentVoice}`:'Silent'}</div></div><div><span>Cast</span><div className="track cast-track">{stageActors.length} portraits{authoredLine?.stage.length?` · ${authoredLine.stage.length} stage events`:''}</div></div></div></div>
          <div className="preview-note">{session && retailStage?.warning && <p className="inline-warning">{retailStage.warning}</p>}<p>{project?'Each line uses its configured duration. A shorter duration can cut off its voice clip.':'Portraits and held facial frames follow the selected dialogue cue. This five-second audition does not replay movement or expression changes within the line.'}</p></div>
          <div className="asset-status"><span className={`status-dot ${assets.names.length?'':'dim'}`}/><span>{assets.names.length?'Bundled portraits loaded':'Loading portraits…'}</span><button className="text-button" onClick={()=>setAssetsOpen(true)}>{assets.banks.size?'Voice banks loaded':'Load voices (optional)'}</button></div>
        </section>
      </main><footer className="statusbar"><span><span className="status-dot"/>{busy?'Working locally…':validationError?'Export needs attention':'Local workspace'}</span><span>{project?'Authored script':`${session?.document.byteLength.toLocaleString()} source bytes`} · {history.past.length} undo steps</span></footer>
    </>}
    {assetsOpen&&<div className="modal-backdrop" onClick={()=>setAssetsOpen(false)}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="voices-title" onClick={event=>event.stopPropagation()}><div className="modal-heading"><h2 id="voices-title">Load voice clips</h2><button aria-label="Close voices" onClick={()=>setAssetsOpen(false)}>×</button></div><p>Voice preview is optional. Select any of these banks from your game’s <code>VOICE_JP</code> folder:</p><ul className="voice-files"><li><code>CHT_COMMON.AWB</code></li><li><code>CHT_DISC_1.AWB</code></li><li><code>CHT_DISC_2.AWB</code></li></ul><p>{assets.banks.size?`${assets.banks.size} banks loaded.`:'No voice banks loaded.'} Files are read locally and need to be selected again after reloading the editor.</p><div className="modal-actions"><button disabled={busy} onClick={()=>assetInput.current?.click()}>Select voice banks</button><button onClick={()=>setAssetsOpen(false)}>Close</button></div></section></div>}
    {portraitPicker && workspace && <PortraitPicker assets={assets} assetRevision={assetRevision} selected={portraitPicker.selected} onSelect={choosePortrait} onClose={()=>setPortraitPicker(null)}/>}
    {portraitReplacement && portraitReplacement.workspace === workspace && <PortraitReplacement from={portraitReplacement.target.selected} to={portraitReplacement.slot} localReason={portraitChanges?.local.reason} allReason={portraitChanges?.all.reason} authored={!!project} onApply={confirmPortraitReplacement} onClose={()=>setPortraitReplacement(null)}/>}
    {conversionOpen&&session&&<div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="convert-title"><div className="modal-heading"><h2 id="convert-title">Edit this skit as a sequence</h2><button aria-label="Cancel conversion" onClick={()=>setConversionOpen(false)}>×</button></div><p>Rebuilds this file using its dialogue, reconstructed cast, and voice IDs. This enables line reordering, independent durations, voice disabling, and per-line staging.</p><p className="inline-warning">Original branches, parallel choreography, embedded text controls, and voice milestones are not copied. Each new line starts at three seconds; adjust durations or fit them to voice clips.</p><div className="modal-actions"><button onClick={()=>setConversionOpen(false)}>Keep original script</button><button className="primary" onClick={()=>{saveProject();replace({kind:'authored',project:toAuthored(session)},'Sequence editing enabled. The original project was downloaded first.',true);setConversionOpen(false);}}>Save original & edit sequence</button></div></section></div>}
  </div>;
}
