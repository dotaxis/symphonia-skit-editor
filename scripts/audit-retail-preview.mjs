#!/usr/bin/env node
// Read-only, optional corpus audit; no extracted scripts or dialogue are saved.
// Usage: node scripts/audit-retail-preview.mjs /path/to/R01/CHT
import { readFile, readdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { initSync, parse_skit } from '../src/wasm/core.js';

const directory = process.argv[2];
if (!directory) throw new Error('Usage: node scripts/audit-retail-preview.mjs /path/to/R01/CHT');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
initSync({ module: await readFile(join(root, 'src/wasm/core_bg.wasm')) });
const { outputFiles } = buildSync({ stdin: { contents: `
  export { retailStages, traceRetailContext } from './src/retail-projection';
  export { dialogueLines } from './src/model';
`, resolveDir: root, loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'esm' });
const { retailStages, traceRetailContext, dialogueLines } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
const rows = [], failures = [];
for (const filename of (await readdir(directory)).filter(name => /\.skp$/i.test(name)).sort()) {
  try {
    const original = await readFile(join(directory, filename)), document = JSON.parse(parse_skit(original));
    const session = { filename, original, document, edits: { messages: [], literals: [] } };
    const lines = dialogueLines(session), stages = retailStages(session, lines);
    const main = traceRetailContext(session, document.defaultPc);
    const subtitle = document.entries.find(entry => entry.kind === 2 && entry.id === 3000);
    const overlay = subtitle ? traceRetailContext(session, subtitle.pc) : undefined;
    rows.push({ filename, subtitleRows: lines.filter(line => line.binding === 'skit').length,
      mainComplete: main.complete, subtitleComplete: overlay?.complete ?? true,
      distinctAppearances: new Set(stages.map(stage => JSON.stringify(stage.actors.map(actor =>
        [actor.id, actor.slot, actor.animationSlot, actor.eyeFrame, actor.mouthFrame])))).size,
      initialSubtitleRows: lines.flatMap((line, i) => line.binding === 'skit' && stages[i].warning?.includes('initial cast') ? [i + 1] : []),
      warnings: [...new Set([...main.warnings, ...overlay?.warnings ?? []])] });
  } catch (error) { failures.push({ filename, error: String(error) }); }
}
const portraitSkits = rows.filter(row => row.subtitleRows > 0);
console.log(JSON.stringify({
  method: 'Same bounded instruction tracing and cue snapshots as the editor; no game execution or timing-parity claim.',
  files: rows.length + failures.length, parsedFiles: rows.length,
  completeMainContexts: rows.filter(row => row.mainComplete).length,
  portraitSubtitleFiles: portraitSkits.length,
  completePortraitContexts: portraitSkits.filter(row => row.mainComplete && row.subtitleComplete).length,
  filesWithChangingAppearances: rows.filter(row => row.distinctAppearances > 1).length,
  initialSubtitleRows: portraitSkits.filter(row => row.initialSubtitleRows.length).map(({ filename, initialSubtitleRows }) => ({ filename, rows: initialSubtitleRows })),
  incompletePortraitContexts: portraitSkits.filter(row => !row.mainComplete || !row.subtitleComplete),
  otherIncompleteFiles: rows.filter(row => !row.subtitleRows && !row.mainComplete).map(row => row.filename),
  failures,
}, null, 2));
