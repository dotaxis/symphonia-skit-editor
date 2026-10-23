import { useEffect, useRef, useState } from 'react';
import { Assets, animationFrame, type PortraitAsset } from './assets';
import { nearestStagePosition, standardStagePositions, uniqueStagePositions, type StagePosition } from './stage-layouts';

export interface StageActor { id: number; name: string; slot: number; animationSlot?: number; x: number; y: number; scale: number; rotation?: number; alpha?: number; visible?: boolean; eyeFrame?: number; mouthFrame?: number; animationStartSeconds?: number }
interface Props {
  assets: Assets; assetRevision: number; actors: StageActor[]; originalActors?: StageActor[]; speaker?: number; text: string;
  seconds: number; selected?: number;
  onSelect: (id: number) => void; onReplace?: (id: number) => void;
  onPlace?: (id: number, x: number, y: number, swapWith?: number) => void;
  positionReason?: (id: number, x: number, y: number, swapWith?: number) => string | undefined;
}
interface Gesture {
  id: number; pointerId: number; dx: number; dy: number; startX: number; startY: number; moved: boolean; actors: StageActor[]; point: StagePosition;
}
interface DragPreview { id: number; x: number; y: number; target?: StagePosition; swapWith?: number; reason?: string }
const W = 1920, H = 1080;
// Native PC sprite placement at 0x555A50, before local scale and rotation.
const center = (actor: StageActor) => ({ x: actor.x * 1.9 + 356, y: actor.y * 2 + 64 });
// Match the corpus audit's logical stage bounds; off-screen exits are not cast slots.
const onStage = (actor: StageActor) => actor.visible !== false && (actor.alpha ?? 255) > 0 && actor.scale > 0
  && actor.x >= 0 && actor.x <= 640 && actor.y >= 0 && actor.y <= 400;

export default function Stage(props: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [loaded, setLoaded] = useState(new Map<number, PortraitAsset>());
  const [missing, setMissing] = useState<string[]>([]);
  const drag = useRef<Gesture | null>(null);
  const [dragPreview, setDragPreview] = useState<DragPreview | null>(null);
  const interactive = !!(props.onReplace || props.onPlace);
  const visibleActors = props.actors.filter(onStage);
  const positions = uniqueStagePositions([
    ...standardStagePositions(visibleActors.length),
    ...(props.originalActors ?? []).filter(onStage).map(({ x, y }) => ({ x: Math.round(x), y: Math.round(y) })),
    ...visibleActors.map(({ x, y }) => ({ x: Math.round(x), y: Math.round(y) })),
  ]);
  function cancelGesture() {
    const gesture = drag.current; drag.current = null; setDragPreview(null);
    if (gesture && canvas.current?.hasPointerCapture(gesture.pointerId)) canvas.current.releasePointerCapture(gesture.pointerId);
  }
  useEffect(() => {
    if (!interactive || drag.current && drag.current.actors !== props.actors) cancelGesture();
  }, [interactive, props.actors]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cancelGesture();
      else if (event.key === 'Shift' && drag.current?.moved) {
        previewPlacement(drag.current.point, drag.current, event.type === 'keydown');
      }
    };
    window.addEventListener('keydown', key);
    window.addEventListener('keyup', key);
    window.addEventListener('blur', cancelGesture);
    return () => {
      window.removeEventListener('keydown', key);
      window.removeEventListener('keyup', key);
      window.removeEventListener('blur', cancelGesture);
    };
  });
  const slots = [...new Set(props.actors.map(actor => actor.slot))].sort((a,b) => a-b).join(',');
  useEffect(() => {
    let active = true;
    const ids = slots ? slots.split(',').map(Number) : [];
    Promise.all(ids.map(async id => {
      try { return { id, asset: await props.assets.portrait(id) }; }
      catch (error) { return { id, error: String(error) }; }
    })).then(results => {
      if (!active) return;
      setLoaded(new Map(results.filter(result => result.asset).map(result => [result.id, result.asset!])));
      setMissing(results.flatMap(result => result.error ? [result.error] : result.asset!.missing.map(name => `Missing ${name}`)));
    });
    return () => { active = false; };
  }, [slots, props.assets, props.assetRevision]);

  useEffect(() => {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx) return;
    const gradient = ctx.createLinearGradient(0, 0, W, H);
    gradient.addColorStop(0, '#171e35'); gradient.addColorStop(1, '#30304a');
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#ffffff07'; ctx.lineWidth = 1;
    for (let x = 0; x < W; x += 80) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (let y = 0; y < H; y += 80) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    if (dragPreview) for (const position of positions) {
      const cx = position.x * 1.9 + 356, cy = position.y * 2 + 64;
      const active = dragPreview.target?.x === position.x && dragPreview.target.y === position.y;
      ctx.strokeStyle = active ? dragPreview.reason ? '#e7a08f' : '#ffdd84' : '#a6efdc88';
      ctx.fillStyle = '#101827bb'; ctx.lineWidth = active ? 5 : 2;
      ctx.beginPath(); ctx.arc(cx, cy, active ? 28 : 18, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx - 10, cy); ctx.lineTo(cx + 10, cy);
      ctx.moveTo(cx, cy - 10); ctx.lineTo(cx, cy + 10); ctx.stroke();
    }
    // Cast-list selection brings an overlapped portrait forward while editing.
    const ordered = interactive ? [...props.actors.filter(actor => actor.id !== props.selected),
      ...props.actors.filter(actor => actor.id === props.selected)] : props.actors;
    const origin = props.actors.find(actor => actor.id === dragPreview?.id);
    const displayedActors = dragPreview ? [
      ...ordered.filter(actor => actor.id !== dragPreview.id).map(actor =>
        actor.id === dragPreview.swapWith && !dragPreview.reason && origin ? {
          ...actor, x: Math.round(origin.x), y: Math.round(origin.y), alpha: Math.min(actor.alpha ?? 255, 160),
        } : actor),
      ...ordered.filter(actor => actor.id === dragPreview.id).map(actor => ({
        ...actor, x: dragPreview.x, y: dragPreview.y, alpha: Math.min(actor.alpha ?? 255, 160),
      })),
    ] : ordered;
    for (const actor of displayedActors) {
      if (actor.visible === false || (actor.alpha ?? 255) <= 0 || actor.scale <= 0) continue;
      const asset = loaded.get(actor.slot);
      const base = asset?.textures[0];
      const width = base?.width ?? 400, height = base?.height ?? 496;
      const { x: cx, y: cy } = center(actor);
      ctx.save(); ctx.translate(cx, cy); ctx.scale(actor.scale, actor.scale);
      ctx.rotate((actor.rotation ?? 0) * Math.PI / 180);
      ctx.globalAlpha = Math.min(255, Math.max(0, actor.alpha ?? 255)) / 255;
      const x = -width / 2, y = -height / 2;
      if (base) {
        ctx.drawImage(base, x, y);
        // Property 63 changes animation tables without replacing the loaded texture.
        const animation = actor.animationSlot === undefined ? asset?.animation : props.assets.catalog?.slots[actor.animationSlot];
        for (const tag of [0x7006, 0x7000, 0x7003]) {
          const channel = animation?.channels.find(item => item.tag === tag);
          if (!channel) continue;
          const forced = tag === 0x7000 ? actor.eyeFrame : tag === 0x7003 ? actor.mouthFrame : undefined;
          const frame = forced !== undefined && forced >= 0 && forced !== 255 ? channel.frames[forced]
            : animationFrame(channel, props.seconds - (actor.animationStartSeconds ?? 0), props.speaker === actor.id);
          const texture = frame && asset?.textures[frame.texture];
          const units = props.assets.catalog?.coordinate_scale ?? 2;
          if (texture && frame) ctx.drawImage(texture, x + frame.x * units, y + frame.y * units);
        }
      } else {
        ctx.fillStyle = props.speaker === actor.id ? '#8cd9cc22' : '#ffffff0c';
        ctx.strokeStyle = props.speaker === actor.id ? '#8cd9cc' : '#687387'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.roundRect(x, y, width, height, 32); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#94a5b9'; ctx.beginPath(); ctx.arc(0, -70, 65, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.ellipse(0, 90, 110, 125, 0, Math.PI, Math.PI * 2); ctx.fill();
        ctx.font = '28px system-ui'; ctx.textAlign = 'center'; ctx.fillText(`Portrait ${actor.slot}`, 0, 170);
      }
      if (props.selected === actor.id || dragPreview?.swapWith === actor.id) {
        ctx.strokeStyle = dragPreview?.id === actor.id || dragPreview?.swapWith === actor.id
          ? dragPreview.reason ? '#e7a08f' : '#ffdd84' : '#a6efdc';
        ctx.lineWidth = 3; ctx.setLineDash([10,8]);
        ctx.strokeRect(x - 12, y - 12, width + 24, height + 24); ctx.setLineDash([]);
      }
      ctx.restore();
      ctx.font = '24px system-ui'; ctx.textAlign = 'center'; ctx.fillStyle = props.speaker === actor.id ? '#adf2db' : '#b8bfce';
      ctx.fillText(actor.name, cx, cy + height * actor.scale / 2 + 38);
    }
    ctx.fillStyle = '#101827ed'; ctx.strokeStyle = '#7783ac88'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.roundRect(105, 815, 1710, 210, 16); ctx.fill(); ctx.stroke();
    ctx.font = '38px Georgia, serif'; ctx.fillStyle = '#f7f3ec'; ctx.textAlign = 'center';
    const textLines = props.text.split('\n');
    textLines.slice(0, 4).forEach((line, index) => ctx.fillText(line, W / 2, 874 + index * 46));
    if (!props.text) { ctx.fillStyle = '#78869e'; ctx.font = '30px system-ui'; ctx.fillText('No dialogue selected', W / 2, 925); }
  }, [props, loaded, dragPreview]);

  function position(event: React.PointerEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / rect.width * W, y: (event.clientY - rect.top) / rect.height * H };
  }
  function inPlacementArea(p: StagePosition) {
    return p.x >= 0 && p.x <= W && p.y >= 0 && p.y < 815;
  }
  function hitTest(p: StagePosition) {
    if (!inPlacementArea(p)) return undefined;
    const ordered = [...props.actors.filter(actor => actor.id === props.selected),
      ...[...props.actors].reverse().filter(actor => actor.id !== props.selected)];
    return ordered.find(item => {
      if (item.visible === false || (item.alpha ?? 255) <= 0 || !Number.isFinite(item.scale) || item.scale <= 0) return false;
      const c = center(item), dx = (p.x - c.x) / item.scale, dy = (p.y - c.y) / item.scale;
      const angle = -(item.rotation ?? 0) * Math.PI / 180;
      const localX = dx * Math.cos(angle) - dy * Math.sin(angle), localY = dx * Math.sin(angle) + dy * Math.cos(angle);
      const texture = loaded.get(item.slot)?.textures[0];
      return Math.abs(localX) < (texture?.width ?? 400) / 2 && Math.abs(localY) < (texture?.height ?? 496) / 2;
    });
  }
  function occupantAt(target: StagePosition, id: number) {
    return [...visibleActors].reverse().find(actor => actor.id !== id
      && Math.round(actor.x) === target.x && Math.round(actor.y) === target.y);
  }
  function placement(p: StagePosition, gesture: Gesture, shift: boolean): Pick<DragPreview, 'target' | 'swapWith' | 'reason'> {
    if (!props.onPlace || !inPlacementArea(p)) return {};
    const target = nearestStagePosition({ x: (p.x - gesture.dx - 356) / 1.9, y: (p.y - gesture.dy - 64) / 2 }, positions, Infinity);
    const swapWith = shift && target ? occupantAt(target, gesture.id)?.id : undefined;
    return { target, swapWith, reason: target && props.positionReason?.(gesture.id, target.x, target.y, swapWith) };
  }
  function previewPlacement(p: StagePosition, gesture: Gesture, shift: boolean) {
    if (!props.onPlace) return;
    const proposal = placement(p, gesture, shift);
    setDragPreview({ id: gesture.id, x: proposal.target?.x ?? (p.x - gesture.dx - 356) / 1.9,
      y: proposal.target?.y ?? (p.y - gesture.dy - 64) / 2, ...proposal });
  }
  const occupant = dragPreview?.target && occupantAt(dragPreview.target, dragPreview.id);
  return <div className="stage-wrap">
    <canvas ref={canvas} width={W} height={H} aria-label={interactive
      ? 'Skit stage preview. Click a portrait to replace it, or drag to a standard position, including an empty one. Hold Shift while dragging onto another portrait to swap positions. Select overlapping portraits in the cast list. Escape cancels a drag.'
      : 'Skit stage preview. Open Cast & staging to replace portraits or change their positions.'}
      style={{ touchAction: interactive ? 'none' : 'auto', cursor: dragPreview ? dragPreview.target && !dragPreview.reason ? 'grabbing' : 'no-drop' : interactive ? 'pointer' : 'default' }}
      onPointerDown={event => {
        if (!interactive || event.button !== 0 || drag.current) return;
        const p = position(event);
        const actor = hitTest(p);
        if (!actor) return;
        props.onSelect(actor.id);
        const c = center(actor);
        drag.current = { id: actor.id, pointerId: event.pointerId, dx: p.x - c.x, dy: p.y - c.y,
          startX: event.clientX, startY: event.clientY, moved: false, actors: props.actors, point: p };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={event => {
        if (!drag.current || drag.current.pointerId !== event.pointerId) return;
        if (!interactive || drag.current.actors !== props.actors) { cancelGesture(); return; }
        const p = position(event), d = drag.current;
        d.point = p;
        d.moved ||= Math.hypot(event.clientX - d.startX, event.clientY - d.startY) >= 5;
        if (d.moved) previewPlacement(p, d, event.shiftKey);
      }} onPointerUp={event => {
        const gesture = drag.current;
        if (!gesture || gesture.pointerId !== event.pointerId) return;
        cancelGesture();
        if (!interactive || gesture.actors !== props.actors) return;
        gesture.moved ||= Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) >= 5;
        if (!gesture.moved) props.onReplace?.(gesture.id);
        else {
          const { target, swapWith, reason } = placement(position(event), gesture, event.shiftKey);
          if (target && !reason) props.onPlace?.(gesture.id, target.x, target.y, swapWith);
        }
      }} onPointerCancel={cancelGesture} onLostPointerCapture={cancelGesture} />
    <div className="stage-caption" title={missing.join('\n')}><span aria-live="polite">{dragPreview
      ? dragPreview.reason ?? (dragPreview.swapWith !== undefined ? `Release to swap positions with ${occupant?.name}`
        : dragPreview.target ? `Release at (${dragPreview.target.x}, ${dragPreview.target.y})${occupant ? ` · occupied by ${occupant.name} · hold Shift to swap` : ''}` : 'Drop inside the stage to snap to a position · Escape cancels')
      : interactive ? 'Click to replace · drag to move · Shift-drag to swap positions' : 'Edit portraits in Cast & staging'}</span><span>{missing.length ? `${missing.length} missing portrait assets` : !props.assets.catalog ? 'Loading facial animation data' : 'Animated portraits'} · font approximation</span></div>
  </div>;
}
