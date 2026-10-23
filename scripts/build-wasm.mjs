import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run('cargo', ['build', '--locked', '--manifest-path', 'core/Cargo.toml', '--lib', '--features', 'wasm', '--target', 'wasm32-unknown-unknown', '--release']);
mkdirSync(new URL('../src/wasm/', import.meta.url), { recursive: true });
run(process.env.WASM_BINDGEN ?? 'wasm-bindgen', [
  'core/target/wasm32-unknown-unknown/release/tos_skit_core.wasm',
  '--target', 'web', '--out-dir', 'src/wasm', '--out-name', 'core',
]);
