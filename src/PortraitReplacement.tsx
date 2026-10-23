import { useEffect, useRef } from 'react';
import { characterName } from './characters';

export default function PortraitReplacement({ from, to, localReason, allReason, authored, onApply, onClose }: {
  from: number; to: number; localReason?: string; allReason?: string; authored: boolean;
  onApply: (all: boolean) => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLElement>(null);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
    function keyboard(event: KeyboardEvent) {
      if (event.key === 'Escape') { event.preventDefault(); close.current(); }
      if (event.key !== 'Tab') return;
      const buttons = [...(dialog.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [])];
      const first = buttons[0], last = buttons.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', keyboard);
    return () => { document.removeEventListener('keydown', keyboard); if (previous?.isConnected) previous.focus(); };
  }, []);
  return <div className="modal-backdrop" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialog} className="modal" role="dialog" aria-modal="true" aria-labelledby="replace-portrait-title">
      <div className="modal-heading"><h2 id="replace-portrait-title">Replace portrait?</h2></div>
      <p>Replace <b>{characterName(from) ?? 'Unknown character'} · portrait {from}</b> with <b>{characterName(to) ?? 'Unknown character'} · portrait {to}</b>?</p>
      <p>{authored ? 'This appearance changes the portrait from the selected line until its next portrait change.' : 'This appearance changes this use of the portrait, until the script replaces it again.'} All instances replaces every use of portrait {from} in this skit.</p>
      {localReason && <p className="hint">{localReason}</p>}
      {allReason && allReason !== localReason && <p className="hint">{allReason}</p>}
      <div className="modal-actions">
        <button className="primary" disabled={!!localReason} title={localReason} onClick={() => onApply(false)}>This appearance</button>
        <button disabled={!!allReason} title={allReason} onClick={() => onApply(true)}>All instances</button>
        <button onClick={onClose}>Cancel</button>
      </div>
    </section>
  </div>;
}
