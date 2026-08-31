import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('CLI command registration', () => {
  it('uses the Comers command name and keeps the legacy CLI alias', async () => {
    const [source, packageJson] = await Promise.all([
      readFile(join(process.cwd(), 'src', 'cli', 'index.ts'), 'utf8'),
      readFile(join(process.cwd(), 'package.json'), 'utf8'),
    ]);

    expect(source).toContain(".name('comers')");
    expect(JSON.parse(packageJson)).toMatchObject({
      name: 'comers',
      bin: {
        comers: './bin/comers.mjs',
        'lark-channel-bridge': './bin/lark-channel-bridge.mjs',
      },
    });
  });

  it('registers the documented migrate command', async () => {
    const source = await readFile(join(process.cwd(), 'src', 'cli', 'index.ts'), 'utf8');

    expect(source).toMatch(/\.command\(['"]migrate['"]\)/);
    expect(source).toContain('runMigrate');
  });

  it('registers app-secret options for non-interactive app bootstrap commands', async () => {
    const source = await readFile(join(process.cwd(), 'src', 'cli', 'index.ts'), 'utf8');

    const appSecretOptions = source.match(/--app-secret <secret>/g) ?? [];
    expect(appSecretOptions.length).toBeGreaterThanOrEqual(3);
  });
});
