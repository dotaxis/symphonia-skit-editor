import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { actorName, automaticLabel, characterName, sequenceSpeakerNames } from '../src/characters';
import type { AuthoredLine, AuthoredProject } from '../src/types';

test('every bundled portrait has a name and unused slots stay unidentified', () => {
  const manifest = JSON.parse(readFileSync(new URL('../public/portraits/manifest.json', import.meta.url), 'utf8'));
  const names = new Set<string>();
  for (const [slot, asset] of (manifest.names as (string | null)[]).entries()) {
    const name = characterName(slot);
    if (asset) { expect(name, `portrait ${slot}`).toBeTruthy(); names.add(name!); }
    else expect(name, `unused slot ${slot}`).toBeUndefined();
  }
  expect([...names].sort()).toEqual(['Colette', 'Corrine', 'Genis', 'Kratos', 'Lloyd', 'Mithos', 'Noishe', 'Presea', 'Raine', 'Regal', 'Sheena', 'Zelos']);
  for (const slot of [undefined, -1, 222, NaN, Infinity, 0.5]) expect(characterName(slot)).toBeUndefined();
});

test('names follow portrait slots rather than script actor IDs, preserving custom labels', () => {
  expect(actorName(6, 54)).toBe('Genis');
  expect(actorName(7, 0, 'Character 7')).toBe('Lloyd');
  expect(actorName(7, 11, '   ')).toBe('Lloyd');
  expect(actorName(7, 204, 'Narrator')).toBe('Narrator');
  expect(actorName(7, 205, 'Character 8')).toBe('Character 8');
  expect(actorName(7, 12)).toBe('Actor 7');
  expect(automaticLabel(7, 'Character 7')).toBe(true);
  expect(automaticLabel(7, 'Character 8')).toBe(false);
});

function line(speaker: number, stage: AuthoredLine['stage'] = []): AuthoredLine {
  return { id: String(speaker), speaker, stage, text: '', voiceId: null, voiceEnabled: false,
    durationTicks: 60, eyeFrame: -1, mouthFrame: -1 };
}

function sequence(): AuthoredProject {
  return { filename: 'FC_W001.SKP', actors: [
    { id: 6, name: 'Character 6', textureSlot: 54, x: 100, y: 200, scalePercent: 100, rotation: 0, alpha: 255 },
    { id: 7, name: '', textureSlot: 0, x: 400, y: 200, scalePercent: 100, rotation: 0, alpha: 255 },
  ], rows: [
    line(6),
    line(6, [{ actorId: 6, textureSlot: 180 }, { actorId: 7, textureSlot: 205 }]),
    line(7),
    line(6),
  ] };
}

test('row appearance changes update automatic names without changing earlier rows or the project', () => {
  const project = sequence(), original = JSON.stringify(project);
  expect(sequenceSpeakerNames(project)).toEqual(['Genis', 'Kratos', 'Noishe', 'Kratos']);
  expect(JSON.stringify(project)).toBe(original);
});

test('row appearance changes retain explicit labels and tolerate unresolved draft actors', () => {
  const project = sequence();
  project.actors[0].name = 'Narrator';
  project.rows.push(line(6, [{ actorId: 6, textureSlot: 999 }]));
  project.rows.push(line(20));
  expect(sequenceSpeakerNames(project)).toEqual(['Narrator', 'Narrator', 'Noishe', 'Narrator', 'Narrator', 'Actor 20']);
});
