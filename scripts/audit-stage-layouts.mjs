#!/usr/bin/env node
// Read-only corpus audit. Requires `npm run build:wasm` and extracted PC SKPs.
// Usage: node scripts/audit-stage-layouts.mjs /path/to/R01/CHT > research/stage-layouts.json
import { readFile, readdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { initSync, parse_skit } from '../src/wasm/core.js';

const directory = process.argv[2];
if (!directory) throw new Error('Usage: node scripts/audit-stage-layouts.mjs /path/to/R01/CHT');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
initSync({ module: await readFile(join(root, 'src/wasm/core_bg.wasm')) });
// Use the same constant-folding and dialogue-cue projection as the editor.
const { outputFiles } = buildSync({ stdin: { contents: `
  export { retailStages } from './src/retail-projection';
  export { dialogueLines } from './src/model';
`, resolveDir: root, loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'esm' });
const { retailStages, dialogueLines } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
const files = (await readdir(directory)).filter(name => /\.skp$/i.test(name)).sort();
const counts = new Map(), warnings = new Map(), failures = [];
let dialogueCues = 0, includedCues = 0;
const pointKey = actor => `${actor.x},${actor.y}`;
for (const filename of files) {
  try {
    const original = await readFile(join(directory, filename));
    const document = JSON.parse(parse_skit(original));
    const session = { filename, original, document, edits: { messages: [], literals: [] } };
    const stages = retailStages(session, dialogueLines(session));
    for (const stage of stages) {
      dialogueCues++;
      if (stage.warning) warnings.set(filename, stage.warning);
      // Keep settled portrait anchors in the native 640x400 staging area.
      // This excludes off-screen entry/exit endpoints and does not infer them.
      const actors = stage.actors.filter(actor => actor.visible !== false && actor.alpha > 0 && actor.scale > 0
        && Number.isInteger(actor.x) && Number.isInteger(actor.y)
        && actor.x >= 0 && actor.x <= 640 && actor.y >= 0 && actor.y <= 400);
      if (!actors.length) continue;
      includedCues++;
      const points = actors.map(pointKey).sort((a, b) => {
        const [ax, ay] = a.split(',').map(Number), [bx, by] = b.split(',').map(Number);
        return ay - by || ax - bx;
      });
      const count = counts.get(actors.length) ?? new Map();
      const key = points.join(';');
      const item = count.get(key) ?? { positions: points.map(point => {
        const [x, y] = point.split(',').map(Number); return { x, y };
      }), cues: 0, files: new Set() };
      item.cues++;
      item.files.add(filename);
      count.set(key, item);
      counts.set(actors.length, count);
    }
  } catch (error) { failures.push({ filename, error: String(error) }); }
}
const byActorCount = [...counts].sort(([a], [b]) => a - b).map(([count, layouts]) => ({
  count,
  layouts: [...layouts.values()].sort((a, b) => b.files.size - a.files.size || b.cues - a.cues).map(layout => ({
    positions: layout.positions, files: layout.files.size, cues: layout.cues, examples: [...layout.files].slice(0, 5),
  })),
}));
console.log(JSON.stringify({
  method: 'Unedited retailStages at dialogue cues; visible nonzero-scale/alpha actors with integer centers in native 640x400 area. Constants are folded by the editor. Counts include projection approximations; cue counts are not animation samples. Files counted once per distinct layout.',
  files: files.length, parsedFiles: files.length - failures.length, dialogueCues, includedCues,
  filesWithProjectionWarnings: warnings.size, byActorCount, failures,
}, null, 2));
