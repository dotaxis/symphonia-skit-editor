import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Assets, type PortraitAsset } from './assets';
import { characterName } from './characters';
import './portrait-picker.css';

interface Props {
  assets: Assets;
  assetRevision: number;
  selected: number;
  onSelect: (slot: number) => void;
  onClose: () => void;
}

const PAGE_SIZE = 24;

function Thumbnail({ assets, assetRevision, slot, name, selected, onSelect }: {
  assets: Assets; assetRevision: number; slot: number; name: string; selected: boolean; onSelect: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [portrait, setPortrait] = useState<PortraitAsset>();
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setPortrait(undefined); setError('');
    assets.portrait(slot).then(value => { if (active) setPortrait(value); })
      .catch(error => { if (active) setError(error instanceof Error ? error.message : String(error)); });
    return () => { active = false; };
  }, [assets, assetRevision, slot]);
  useEffect(() => {
    const context = canvas.current?.getContext('2d'), base = portrait?.textures[0];
    if (!context || !base) return;
    context.clearRect(0, 0, 192, 240);
    const scale = Math.min(176 / base.width, 224 / base.height);
    context.save();
    context.translate((192 - base.width * scale) / 2, (240 - base.height * scale) / 2);
    context.scale(scale, scale);
    context.drawImage(base, 0, 0);
    // The bundled first-frame overlays complete the base portrait.
    for (const tag of [0x7006, 0x7000, 0x7003]) {
      const frame = portrait?.animation?.channels.find(channel => channel.tag === tag)?.frames[0];
      const texture = frame && portrait?.textures[frame.texture];
      if (texture && frame) context.drawImage(texture, frame.x * 2, frame.y * 2);
    }
    context.restore();
  }, [portrait]);

  return <button type="button" className={`portrait-choice${selected ? ' is-selected' : ''}`}
    aria-label={`Select portrait ${slot}, ${characterName(slot) ?? 'Unknown character'}, ${name}`} aria-pressed={selected}
    title={error || `${name}${portrait?.missing.length ? ' · Some expression layers are missing' : ''}`}
    onClick={onSelect}>
    <span className="portrait-thumbnail">
      {portrait ? <canvas ref={canvas} width={192} height={240} aria-hidden="true" />
        : <span className={`portrait-placeholder${error ? ' has-error' : ''}`}>
          <span aria-hidden="true">{error ? '◇' : '…'}</span>
          <small>{error ? 'Preview unavailable' : 'Loading portrait'}</small>
        </span>}
      {selected && <span className="portrait-current" aria-hidden="true">✓</span>}
    </span>
    <span className="portrait-choice-label"><b>{characterName(slot) ?? 'Unknown character'}</b><small>Portrait {slot} · {name}</small></span>
    {error && <span className="portrait-error">Missing or unreadable asset</span>}
  </button>;
}

/** A local gallery: only the current page requests decoded portrait bitmaps. */
export default function PortraitPicker({ assets, assetRevision, selected, onSelect, onClose }: Props) {
  const titleId = useId(), searchId = useId();
  const dialog = useRef<HTMLElement>(null), searchInput = useRef<HTMLInputElement>(null);
  const close = useRef(onClose); close.current = onClose;
  const [query, setQuery] = useState('');
  const entries = useMemo(() => assets.names.flatMap((name, slot) => name ? [{ name, slot }] : []), [assets, assetRevision]);
  const [page, setPage] = useState(() => Math.max(0, Math.floor(entries.findIndex(entry => entry.slot === selected) / PAGE_SIZE)));
  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    return entries.filter(entry => !term || String(entry.slot).includes(term) || entry.name.toLowerCase().includes(term)
      || characterName(entry.slot)?.toLowerCase().includes(term));
  }, [entries, query]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages - 1);
  const visible = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    searchInput.current?.focus();
    function keyboard(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); close.current(); return;
      }
      if (event.key !== 'Tab') return;
      const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex="0"]') ?? [])]
        .filter(control => control.getClientRects().length > 0);
      const first = controls[0], last = controls.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || !dialog.current?.contains(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.current?.contains(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    }
    document.addEventListener('keydown', keyboard, true);
    return () => { document.removeEventListener('keydown', keyboard, true); if (previous?.isConnected) previous.focus(); };
  }, []);

  function select(slot: number) { onSelect(slot); onClose(); }
  return <div className="modal-backdrop portrait-picker-backdrop" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialog} className="modal portrait-picker" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="modal-heading"><div><h2 id={titleId}>Choose a portrait</h2></div>
        <button type="button" aria-label="Close portrait gallery" onClick={onClose}>×</button></div>
      <p>Select a portrait resource.</p>
      <label className="portrait-search" htmlFor={searchId}><span>Search by character, portrait ID, or PAC filename</span>
        <input ref={searchInput} id={searchId} type="search" value={query} placeholder="For example: Sheena, 96, or skit51"
          onChange={event => { setQuery(event.target.value); setPage(0); }} /></label>
      <div className="portrait-gallery-status" role="status" aria-live="polite">
        {filtered.length ? `${filtered.length} portraits · showing ${currentPage * PAGE_SIZE + 1}–${Math.min(filtered.length, (currentPage + 1) * PAGE_SIZE)}` : entries.length ? 'No matching portraits' : 'Portrait catalog unavailable'}
      </div>
      {visible.length ? <div className="portrait-gallery">
        {visible.map(entry => <Thumbnail key={entry.slot} assets={assets} assetRevision={assetRevision} slot={entry.slot} name={entry.name}
          selected={entry.slot === selected} onSelect={() => select(entry.slot)} />)}
      </div> : <div className="portrait-gallery-empty">
        {entries.length ? 'Try a different character name, portrait ID, or filename.' : 'The bundled portrait catalog could not be loaded. Reload the editor to try again.'}
      </div>}
      <div className="portrait-pagination">
        <button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)} aria-label="Previous portrait page">← Previous</button>
        <span>Page {currentPage + 1} of {pages}</span>
        <button type="button" disabled={currentPage >= pages - 1} onClick={() => setPage(currentPage + 1)} aria-label="Next portrait page">Next →</button>
      </div>
    </section>
  </div>;
}
