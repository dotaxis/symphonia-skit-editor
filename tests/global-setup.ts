import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export default function globalSetup() {
  const fixtures = mkdtempSync(join(tmpdir(), 'tos-skit-browser-'));
  execFileSync('cargo', ['run', '--offline', '--quiet', '--manifest-path', resolve('core/Cargo.toml'), '--bin', 'make-fixture', '--', fixtures], {
    stdio: 'inherit', timeout: 120_000,
  });
  process.env.SKIT_TEST_FIXTURES = fixtures;
}
