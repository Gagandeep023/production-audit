import { describe, expect, it } from 'vitest';
import { compareVersions, parseVersion, satisfies } from './semver';

describe('parseVersion', () => {
  it('fills in the parts that were left off', () => {
    expect(parseVersion('8')).toEqual({ major: 8, minor: 0, patch: 0, prerelease: '' });
    expect(parseVersion('v8.13')).toEqual({ major: 8, minor: 13, patch: 0, prerelease: '' });
  });

  it('rejects anything that is not a version', () => {
    expect(parseVersion('next')).toBeNull();
    expect(parseVersion('')).toBeNull();
  });
});

describe('compareVersions', () => {
  it('sorts a prerelease below the release it leads to', () => {
    const rc = parseVersion('5.0.0-rc.1');
    const release = parseVersion('5.0.0');
    expect(compareVersions(rc!, release!)).toBe(-1);
  });
});

describe('satisfies', () => {
  it.each([
    ['8.13.1', '>=8', true],
    ['7.9.0', '>=8', false],
    ['5.0.0', '>=5', true],
    ['4.16.0', '>=5', false],
    ['6.1.0', '>=5 <7', true],
    ['7.0.0', '>=5 <7', false],
    ['8.13.1', '^8.0.0', true],
    ['9.0.0', '^8.0.0', false],
    ['0.2.3', '^0.2.0', true],
    ['0.3.0', '^0.2.0', false],
    ['8.13.1', '8.x', true],
    ['9.0.1', '8.x', false],
    ['8.13.1', '8.13.x', true],
    ['8.14.0', '8.13.x', false],
    ['8.13.1', '8 - 9', true],
    ['10.0.0', '8 - 9', false],
    ['3.0.0', '>=8 || <=3', true],
    ['8.13.1', '*', true],
    ['8.13.1', '', true],
  ])('%s against %s is %s', (version, range, expected) => {
    expect(satisfies(version, range)).toBe(expected);
  });

  it('matches nothing when the range cannot be parsed', () => {
    // Failing closed keeps a typo in a contributed rule from making it fire
    // on every version of every library.
    expect(satisfies('8.13.1', 'not-a-range')).toBe(false);
  });

  it('matches nothing when the version cannot be parsed', () => {
    expect(satisfies('main', '>=8')).toBe(false);
  });
});
