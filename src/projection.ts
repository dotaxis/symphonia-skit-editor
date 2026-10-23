import type { StageActor } from './Stage';
import type { AuthoredProject, StageChange } from './types';
import { actorName } from './characters';

const finite = (value: number | undefined, fallback: number) =>
  value !== undefined && Number.isFinite(value) ? value : fallback;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const fraction = (seconds: number, duration: number) => duration <= 0 ? 1 : clamp(seconds / duration, 0, 1);
const interpolate = (from: number, to: number, progress: number) => from + (to - from) * progress;
const frame = (value: number) => Number.isInteger(value) && value >= -1 && value <= 254 ? value : -1;
const rowSeconds = (ticks: number) => Math.max(0, finite(ticks, 0)) / 60;

interface State extends StageActor { animationStart: number }

function applyStage(actor: State, change: StageChange, elapsed: number, rowStart: number): void {
  const previous = { ...actor };
  const x = finite(change.x, actor.x), y = finite(change.y, actor.y);
  const slot = change.textureSlot !== undefined && Number.isInteger(change.textureSlot) && change.textureSlot >= 0 && change.textureSlot < 222
    ? change.textureSlot : actor.slot;
  const scale = clamp(finite(change.scalePercent, actor.scale * 100), 0, 1000) / 100;
  const alpha = clamp(finite(change.alpha, actor.alpha ?? 255), 0, 255);
  const visible = change.visible ?? actor.visible;
  const movementTicks = Math.max(0, finite(change.movementTicks, 0));
  const fadeTicks = Math.max(0, finite(change.fadeTicks, 0));
  const replace = actor.visible === false || slot !== actor.slot || alpha !== actor.alpha || fadeTicks > 0;

  actor.slot = slot;
  actor.rotation = finite(change.rotation, actor.rotation ?? 0);
  actor.visible = visible;

  // Hidden actors retain their authored target state. Showing them later
  // creates a fresh native portrait from that state.
  if (visible === false) {
    actor.x = x; actor.y = y; actor.scale = scale; actor.alpha = alpha;
    return;
  }

  const progress = fraction(elapsed, movementTicks / 60);
  actor.x = interpolate(previous.x, x, progress);
  actor.y = interpolate(previous.y, y, progress);
  if (replace) {
    actor.scale = scale;
    actor.eyeFrame = -1;
    actor.mouthFrame = -1;
    actor.animationStart = rowStart;
    // The author compiler translates 60 Hz fadeTicks to native 30 FPS update
    // counts. Native fade durations zero and one apply opacity immediately.
    const fadeFrames = Math.ceil(fadeTicks / 2);
    actor.alpha = alpha * fraction(elapsed, fadeFrames <= 1 ? 0 : fadeFrames / 30);
  } else {
    actor.scale = interpolate(previous.scale, scale, progress);
    actor.alpha = alpha;
  }
}

/**
 * Seek an authored project deterministically without mutating it. The supplied
 * time is relative to the selected dialogue row. Previous rows are projected to
 * completion, and current movement, scale and opacity are linear. Loading and
 * native-context scheduling can add small game-side delays; this is a preview
 * of the authored timing, not a full game VM or a retail choreography player.
 */
export function projectStage(project: AuthoredProject, selected: number, timeSeconds: number): StageActor[] {
  const actors: State[] = project.actors.map(actor => ({
    id: actor.id, name: actor.name, slot: actor.textureSlot,
    x: finite(actor.x, 320), y: finite(actor.y, 200),
    scale: clamp(finite(actor.scalePercent, 100), 0, 1000) / 100,
    rotation: finite(actor.rotation, 0), alpha: clamp(finite(actor.alpha, 255), 0, 255),
    visible: true, eyeFrame: -1, mouthFrame: -1, animationStart: 0,
  }));
  const byId = new Map(actors.map(actor => [actor.id, actor]));
  const current = clamp(Math.floor(finite(selected, 0)), 0, Math.max(0, project.rows.length - 1));
  let rowStart = 0;
  for (let index = 0; index <= current && index < project.rows.length; index++) {
    const row = project.rows[index], duration = rowSeconds(row.durationTicks);
    const elapsed = index < current ? duration : clamp(finite(timeSeconds, 0), 0, duration);
    for (const change of row.stage ?? []) {
      const actor = byId.get(change.actorId);
      if (actor) applyStage(actor, change, elapsed, rowStart);
    }
    // These native properties persist on each actor until another override or
    // a portrait replacement. A speaker change alone does not clear them.
    const speaker = byId.get(row.speaker);
    if (speaker) {
      speaker.eyeFrame = frame(row.eyeFrame);
      speaker.mouthFrame = frame(row.mouthFrame);
    }
    if (index < current) rowStart += duration;
  }
  return actors.map(({ animationStart, ...actor }) => ({
    ...actor, name: actorName(actor.id, actor.slot, actor.name), animationStartSeconds: animationStart - rowStart,
  }));
}
