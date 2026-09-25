import { describe, expect, it } from 'vitest';
import { evaluate } from './evaluate';
import { builtinRules } from '../rules/index';
import type { Rule } from '../types/index';
import {
  configuredPool,
  configuredServer,
  defaultPool,
  defaultServer,
  effective,
  explicit,
  fetchSite,
  observation,
  unknown,
  unset,
} from './__fixtures__/observations';

const rules = builtinRules();

describe('the silence tests', () => {
  /**
   * The single most important test in the suite. A tool that fires on
   * deliberate configuration gets muted, and a muted tool gets deleted.
   */
  it('an explicitly configured app produces zero findings', () => {
    const config = effective([
      configuredPool(),
      configuredServer(),
      fetchSite(explicit('AbortSignal')),
    ]);
    expect(evaluate(config, { rules })).toEqual([]);
  });

  it('an explicit value that happens to equal the default is still explicit', () => {
    // keepAliveTimeout defaults to 5000. Writing `server.keepAliveTimeout =
    // 5000` is indistinguishable by value from never touching it, so intent
    // has to come from the assignment, and this is where that is asserted.
    const server = observation({
      id: 'http#3',
      subsystem: 'http',
      target: 'http.Server',
      library: 'node',
      settings: {
        keepAliveTimeout: explicit(5000, 5000),
        headersTimeout: explicit(60000, 60000),
        requestTimeout: explicit(300000, 300000),
        timeout: explicit(0, 0),
      },
    });
    expect(evaluate(effective([server]), { rules })).toEqual([]);
  });

  it('a pool with a deliberate connectionTimeoutMillis of 0 still fires', () => {
    // The mirror image of the test above, and the line between the two ideas:
    // `applySafeDefaults` must never overwrite a deliberate 0, but the audit
    // still reports it, because the developer asked what is dangerous here.
    const pool = configuredPool({
      connectionTimeoutMillis: explicit(0, 0),
      idleTimeoutMillis: explicit(30000, 10000),
      max: explicit(20, 10),
      statement_timeout: explicit(30000),
      query_timeout: explicit(30000),
      allowExitOnIdle: explicit(false, false),
    });
    const findings = evaluate(effective([pool]), { rules });
    expect(findings.map((f) => f.ruleId)).toEqual(['pg/pool-connection-timeout-unbounded']);
  });
});

describe('a default-configured app', () => {
  it('produces the expected findings, with the right severity and location', () => {
    const findings = evaluate(effective([defaultPool()]), { rules });
    expect(findings.map((f) => f.ruleId)).toEqual([
      'pg/pool-connection-timeout-unbounded',
      'pg/no-statement-timeout',
    ]);

    const first = findings[0]!;
    expect(first.severity).toBe('critical');
    expect(first.site?.line).toBe(14);
    expect(first.settings[0]).toMatchObject({
      name: 'connectionTimeoutMillis',
      state: 'unset',
      libraryDefault: 0,
    });
  });

  it('flags a server that never had keepAliveTimeout considered', () => {
    const findings = evaluate(effective([defaultServer()]), { rules });
    expect(findings.map((f) => f.ruleId)).toContain('http/keep-alive-timeout-unset');
  });

  it('flags a fetch call site with no signal', () => {
    const findings = evaluate(effective([fetchSite(unset())]), { rules });
    expect(findings.map((f) => f.ruleId)).toEqual(['undici/fetch-no-timeout']);
    expect(findings[0]!.severity).toBe('critical');
  });

  it('sorts the worst thing first', () => {
    const findings = evaluate(effective([defaultPool(), defaultServer()]), { rules });
    expect(findings[0]!.severity).toBe('critical');
  });
});

describe('relationships between two settings', () => {
  it('fires when headersTimeout is below keepAliveTimeout', () => {
    // The class of finding a static linter cannot reach, because neither
    // number is wrong on its own.
    const server = observation({
      id: 'http#4',
      subsystem: 'http',
      target: 'http.Server',
      library: 'node',
      settings: {
        keepAliveTimeout: explicit(65000, 5000),
        headersTimeout: explicit(60000, 60000),
        requestTimeout: explicit(30000, 300000),
        timeout: explicit(0, 0),
      },
    });
    const findings = evaluate(effective([server]), { rules });
    expect(findings.map((f) => f.ruleId)).toEqual(['http/headers-timeout-below-keep-alive']);
  });

  it('stays quiet once the pair is ordered correctly', () => {
    expect(evaluate(effective([configuredServer()]), { rules })).toEqual([]);
  });
});

describe('unknown is not fine', () => {
  it('reports a setting it could not read as unknown rather than passing it', () => {
    const findings = evaluate(
      effective([fetchSite(unknown('a custom dispatcher was passed'))]),
      { rules },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe('unknown');
    expect(findings[0]!.settings[0]!.state).toBe('unknown');
  });

  it('reports a setting nobody observed as unknown', () => {
    const pool = observation({
      id: 'pg.Pool#9',
      subsystem: 'pg',
      target: 'pg.Pool',
      library: 'pg',
      libraryVersion: '8.13.1',
      settings: { connectionTimeoutMillis: explicit(5000, 0) },
    });
    const findings = evaluate(effective([pool]), { rules });
    // Both rules apply and neither setting was observed, so both say unknown.
    // Neither is allowed to quietly count as passing.
    expect(findings.map((f) => [f.ruleId, f.kind])).toEqual([
      ['pg/no-statement-timeout', 'unknown'],
      ['pg/pool-idle-timeout-disabled', 'unknown'],
    ]);
  });

  it('does not let one unknown hide a real finding under match: any', () => {
    const rule: Rule = {
      id: 'test/any',
      library: 'test',
      settings: ['a', 'b'],
      match: 'any',
      dangerousWhen: 'unset',
      severity: 'high',
      why: 'why',
      fix: 'fix',
    };
    const target = observation({
      target: 'thing',
      library: 'test',
      settings: { a: unset(), b: unknown('cannot read') },
    });
    const findings = evaluate(effective([target]), { rules: [rule] });
    expect(findings[0]!.kind).toBe('dangerous');
  });
});

describe('version ranges', () => {
  const pool = (version: string | undefined) =>
    observation({
      id: 'pg.Pool#v',
      subsystem: 'pg',
      target: 'pg.Pool',
      library: 'pg',
      libraryVersion: version,
      settings: { connectionTimeoutMillis: unset(0) },
    });

  it('fires on a version inside the range', () => {
    expect(evaluate(effective([pool('8.13.1')]), { rules }).length).toBeGreaterThan(0);
  });

  it('does not fire on a version below the range', () => {
    const findings = evaluate(effective([pool('7.18.0')]), { rules });
    expect(findings).toEqual([]);
  });

  it('stays inert when the installed version could not be resolved', () => {
    // Firing here would be a guess, and a guessed finding the user cannot
    // verify is how a tool earns a permanent mute.
    expect(evaluate(effective([pool(undefined)]), { rules })).toEqual([]);
  });
});

describe('profiles', () => {
  it('keeps the keep-alive rule off a worker', () => {
    const findings = evaluate(effective([defaultServer()], 'worker'), { rules });
    expect(findings.map((f) => f.ruleId)).not.toContain('http/keep-alive-timeout-unset');
  });

  it('keeps the statement timeout rule off a cli', () => {
    const findings = evaluate(effective([defaultPool()], 'cli'), { rules });
    expect(findings.map((f) => f.ruleId)).not.toContain('pg/no-statement-timeout');
  });

  it('still reports the pool timeout on a worker, because that one is universal', () => {
    const findings = evaluate(effective([defaultPool()], 'worker'), { rules });
    expect(findings.map((f) => f.ruleId)).toContain('pg/pool-connection-timeout-unbounded');
  });
});

describe('suppressions', () => {
  const config = effective([defaultPool()]);
  const suppression = {
    ruleId: 'pg/pool-connection-timeout-unbounded',
    reason: 'migration in flight, tracked in OPS-412',
    expires: '2030-01-01',
  };
  const now = Date.parse('2026-09-26');

  it('silences a finding while it is live', () => {
    const findings = evaluate(config, { rules, suppressions: [suppression], now });
    expect(findings.map((f) => f.ruleId)).not.toContain('pg/pool-connection-timeout-unbounded');
  });

  it('turns back into a finding once it expires', () => {
    const expired = { ...suppression, expires: '2026-01-01' };
    const findings = evaluate(config, { rules, suppressions: [expired], now });
    const finding = findings.find((f) => f.ruleId === suppression.ruleId);
    expect(finding?.kind).toBe('suppressed-expired');
  });

  it('treats an unparseable expiry as expired', () => {
    const broken = { ...suppression, expires: 'never' };
    const findings = evaluate(config, { rules, suppressions: [broken], now });
    expect(findings.find((f) => f.ruleId === suppression.ruleId)?.kind).toBe('suppressed-expired');
  });

  it('reports an expired suppression whose rule no longer fires', () => {
    const stale = {
      ruleId: 'pg/pool-idle-timeout-disabled',
      reason: 'was deliberate at the time',
      expires: '2026-01-01',
    };
    const findings = evaluate(effective([configuredPool()]), { rules, suppressions: [stale], now });
    expect(findings.map((f) => f.ruleId)).toEqual(['audit/suppression-stale']);
    expect(findings[0]!.severity).toBe('info');
  });

  it('narrows to a target when one is given', () => {
    const narrowed = { ...suppression, target: 'something.else' };
    const findings = evaluate(config, { rules, suppressions: [narrowed], now });
    expect(findings.map((f) => f.ruleId)).toContain('pg/pool-connection-timeout-unbounded');
  });
});

describe('minSeverity', () => {
  it('drops everything below the floor', () => {
    const findings = evaluate(effective([defaultPool(), defaultServer()]), {
      rules,
      minSeverity: 'critical',
    });
    expect(findings.every((f) => f.severity === 'critical')).toBe(true);
  });
});

describe('mutation check', () => {
  /**
   * A check only ever observed passing has not been shown to work. Disabling
   * the condition must make the failing fixture pass, otherwise the rule was
   * never the thing producing the finding.
   */
  it('the pool fixture stops failing when the rule condition is inverted', () => {
    const original = rules.find((r) => r.id === 'pg/pool-connection-timeout-unbounded')!;
    const inverted: Rule = { ...original, dangerousWhen: { kind: 'equals', value: 999999 } };
    const withInverted = rules.map((r) => (r.id === original.id ? inverted : r));

    const before = evaluate(effective([defaultPool()]), { rules });
    const after = evaluate(effective([defaultPool()]), { rules: withInverted });

    expect(before.map((f) => f.ruleId)).toContain(original.id);
    expect(after.map((f) => f.ruleId)).not.toContain(original.id);
  });
});
