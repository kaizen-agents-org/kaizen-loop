import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectCommands } from '../src/init/detect.js';
import { STACK_DETECTION_TABLE } from '../src/index.js';

const fixtures = path.join(import.meta.dirname, 'fixtures', 'init-stacks');

describe('detectCommands', () => {
  it.each([
    ['node', 'npm ci', ['npm test', 'npm run lint', 'npm run build']],
    ['python', 'python -m pip install -e .', ['python -m pytest', 'python -m ruff check .']],
    ['go', 'go mod download', ['go test ./...', 'go vet ./...']],
    ['rust', 'cargo fetch', ['cargo test', 'cargo clippy']],
    ['ruby', 'bundle install', ['bundle exec rake', 'bundle exec rspec']]
  ])('proposes setup and verification commands for a %s repository', async (name, setup, verify) => {
    await expect(detectCommands(path.join(fixtures, name))).resolves.toEqual({ setup, verify });
  });

  it('uses the declared priority for a multi-stack repository', async () => {
    await expect(detectCommands(path.join(fixtures, 'multi-stack'))).resolves.toEqual({
      setup: 'npm ci',
      verify: ['npm test']
    });
  });

  it('continues after a malformed higher-priority package.json', async () => {
    await expect(detectCommands(path.join(fixtures, 'malformed-node-go'))).resolves.toEqual({
      setup: 'go mod download',
      verify: ['go test ./...', 'go vet ./...']
    });
  });

  it('returns an empty proposal when no supported manifest exists', async () => {
    await expect(detectCommands(path.join(fixtures, 'unknown'))).resolves.toEqual({ setup: null, verify: [] });
  });

  it('exports the ordered data-only detection contract from the package root', () => {
    expect(STACK_DETECTION_TABLE.map(({ id, manifest }) => ({ id, manifest }))).toEqual([
      { id: 'node', manifest: 'package.json' },
      { id: 'python', manifest: 'pyproject.toml' },
      { id: 'go', manifest: 'go.mod' },
      { id: 'rust', manifest: 'Cargo.toml' },
      { id: 'ruby', manifest: 'Gemfile' }
    ]);
    expect(JSON.parse(JSON.stringify(STACK_DETECTION_TABLE))).toEqual(STACK_DETECTION_TABLE);

    const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8')) as {
      main?: string;
      types?: string;
    };
    expect(pkg.main).toBe('./dist/index.js');
    expect(pkg.types).toBe('./dist/index.d.ts');
  });
});
