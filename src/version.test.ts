import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VERSION } from './version';
import { TYPES_VERSION } from './types/index';
import { RULES_VERSION } from './rules/index';

/**
 * Version constants drift silently. A guard is cheaper than noticing months
 * later that the CLI has been printing the wrong number.
 */
describe('version constants', () => {
  const manifest = JSON.parse(
    readFileSync(join(__dirname, '..', 'package.json'), 'utf8'),
  ) as { version: string };

  it.each([
    ['VERSION', VERSION],
    ['TYPES_VERSION', TYPES_VERSION],
    ['RULES_VERSION', RULES_VERSION],
  ])('%s matches package.json', (_name, value) => {
    expect(value).toBe(manifest.version);
  });
});
