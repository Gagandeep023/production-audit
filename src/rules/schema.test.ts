import { describe, expect, it } from 'vitest';
import { builtinRules, mergeRules, resolveForProfile } from './index';
import { parseRules, validateRule, validateRules } from './schema';

describe('the built-in corpus', () => {
  /**
   * Runs in CI so a contributed rule cannot land malformed. A bad rule does
   * not throw at runtime, it silently never matches, which is the worst
   * failure a check can have.
   */
  it('is valid', () => {
    expect(validateRules(builtinRules())).toEqual([]);
  });

  it('has no duplicate ids', () => {
    const ids = builtinRules().map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every rule a why that explains the consequence, not just the value', () => {
    for (const rule of builtinRules()) {
      expect(rule.why.length).toBeGreaterThan(80);
      expect(rule.fix.length).toBeGreaterThan(20);
    }
  });

  it('only offers a safe default for settings the rule actually checks', () => {
    for (const rule of builtinRules()) {
      for (const key of Object.keys(rule.safeDefaults ?? {})) {
        expect(rule.settings).toContain(key);
      }
    }
  });
});

describe('validateRule', () => {
  const valid = {
    id: 'lib/thing-unset',
    library: 'lib',
    settings: ['thing'],
    dangerousWhen: 'unset',
    severity: 'high',
    why: 'because',
    fix: 'set it',
  };

  it('accepts a minimal rule', () => {
    expect(validateRule(valid)).toEqual([]);
  });

  it.each([
    ['id', { ...valid, id: 'NotAnId' }],
    ['severity', { ...valid, severity: 'catastrophic' }],
    ['settings', { ...valid, settings: [] }],
    ['match', { ...valid, match: 'some' }],
    ['dangerousWhen.kind', { ...valid, dangerousWhen: { kind: 'vibes' } }],
    ['dangerousWhen.value', { ...valid, dangerousWhen: { kind: 'lessThan', value: 'ten' } }],
    ['dangerousWhen.setting', { ...valid, dangerousWhen: { kind: 'lessThanSetting' } }],
    ['profiles', { ...valid, profiles: ['production'] }],
    ['incident', { ...valid, incident: 'see the wiki' }],
    ['library', { ...valid, library: '' }],
  ])('rejects a bad %s', (field, rule) => {
    const errors = validateRule(rule);
    expect(errors.map((e) => e.field)).toContain(field);
  });

  it('rejects a safe default for a setting the rule does not check', () => {
    const errors = validateRule({ ...valid, safeDefaults: { other: 1 } });
    expect(errors.map((e) => e.field)).toContain('safeDefaults.other');
  });

  it('rejects a duplicate id across the corpus', () => {
    const errors = validateRules([valid, valid]);
    expect(errors.some((e) => e.message === 'duplicate rule id')).toBe(true);
  });

  it('throws with every problem named, not just the first', () => {
    expect(() => parseRules([{ ...valid, id: 'BAD', severity: 'nope' }])).toThrow(/id|severity/);
  });
});

describe('mergeRules', () => {
  const base = builtinRules();

  it('lets a user rule replace a built-in of the same id rather than adding a second', () => {
    const retuned = { ...base[0]!, severity: 'low' as const };
    const merged = mergeRules(base, [retuned]);
    expect(merged.filter((r) => r.id === retuned.id)).toHaveLength(1);
    expect(merged.find((r) => r.id === retuned.id)?.severity).toBe('low');
  });

  it('drops a disabled rule entirely', () => {
    const merged = mergeRules(base, [], [base[0]!.id]);
    expect(merged.map((r) => r.id)).not.toContain(base[0]!.id);
  });
});

describe('resolveForProfile', () => {
  const statementTimeout = builtinRules().find((r) => r.id === 'pg/no-statement-timeout')!;

  it('returns the base safe default for the profile that has no override', () => {
    expect(resolveForProfile(statementTimeout, 'http-api')?.safeDefaults).toEqual({
      statement_timeout: 30000,
    });
  });

  it('applies a per-profile override, because one number is not right everywhere', () => {
    expect(resolveForProfile(statementTimeout, 'worker')?.safeDefaults).toEqual({
      statement_timeout: 300000,
    });
  });

  it('disables the rule where the override is null', () => {
    expect(resolveForProfile(statementTimeout, 'cli')).toBeNull();
  });

  it('respects an explicit profile list', () => {
    const keepAlive = builtinRules().find((r) => r.id === 'http/keep-alive-timeout-unset')!;
    expect(resolveForProfile(keepAlive, 'http-api')).not.toBeNull();
    expect(resolveForProfile(keepAlive, 'worker')).toBeNull();
  });
});
