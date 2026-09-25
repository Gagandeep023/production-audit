import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { applySafeDefaults } from './applySafeDefaults';
import { audit } from '../index';
import { reset } from '../core/registry';
import { resetPolicy } from '../core/policy';
import { uninstallHttpServerObserver, wasAssigned } from '../observers/httpServer';
import { uninstallFetchObserver } from '../observers/fetch';

/**
 * A reliability tool that causes an outage is worse than no tool, so these
 * tests are mostly about what `applySafeDefaults()` refuses to do.
 */

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => {
  reset();
  resetPolicy();
});

afterEach(() => {
  uninstallHttpServerObserver();
  uninstallFetchObserver();
  reset();
  resetPolicy();
});

describe('defaults', () => {
  it('reports rather than enforces unless asked', () => {
    expect(applySafeDefaults({ log: false }).mode).toBe('report');
  });

  it('covers every subsystem when none is named', () => {
    expect(applySafeDefaults({ log: false }).subsystems).toEqual(['fetch', 'http', 'pg']);
  });

  it('honours an explicit opt-in list exactly', () => {
    // All-or-nothing means people either take risks they did not evaluate or
    // skip the feature, so one subsystem at a time has to be possible.
    const result = applySafeDefaults({ mode: 'enforce', http: true, pg: false, log: false });
    expect(result.subsystems).toEqual(['http']);
  });

  it('reads the profile from the environment, because the same image ships as both', () => {
    process.env['PRODUCTION_AUDIT_PROFILE'] = 'worker';
    try {
      expect(applySafeDefaults({ log: false }).profile).toBe('worker');
    } finally {
      delete process.env['PRODUCTION_AUDIT_PROFILE'];
    }
  });
});

describe('enforce mode on an http server', () => {
  it('fills a setting nobody assigned', async () => {
    applySafeDefaults({ mode: 'enforce', http: true, log: false });
    const server = http.createServer();
    await tick();

    expect(server.keepAliveTimeout).toBe(65_000);
    expect(server.headersTimeout).toBe(66_000);
    expect(wasAssigned(server, 'keepAliveTimeout')).toBe(false);
    server.close();
  });

  it('never overrides an assignment made in the same tick', async () => {
    // The developer's own line runs immediately after createServer returns,
    // which is why the fill waits for the end of the tick instead of guessing
    // from a value that is identical either way.
    applySafeDefaults({ mode: 'enforce', http: true, log: false });
    const server = http.createServer();
    server.keepAliveTimeout = 12_000;
    await tick();

    expect(server.keepAliveTimeout).toBe(12_000);
    server.close();
  });

  it('never overrides an explicit value equal to the library default', async () => {
    applySafeDefaults({ mode: 'enforce', http: true, log: false });
    const server = http.createServer();
    server.keepAliveTimeout = 5000;
    await tick();

    expect(server.keepAliveTimeout).toBe(5000);
    server.close();
  });

  it('never overrides a constructor option', async () => {
    applySafeDefaults({ mode: 'enforce', http: true, log: false });
    const server = http.createServer({ keepAliveTimeout: 3000 });
    await tick();

    expect(server.keepAliveTimeout).toBe(3000);
    server.close();
  });

  it('clears the finding it fixed', async () => {
    applySafeDefaults({ mode: 'enforce', http: true, log: false });
    const server = http.createServer();
    await tick();

    const ids = audit().findings.map((f) => f.ruleId);
    expect(ids).not.toContain('http/keep-alive-timeout-unset');
    server.close();
  });
});

describe('report mode', () => {
  it('changes nothing observable', async () => {
    applySafeDefaults({ mode: 'report', http: true, log: false });
    const server = http.createServer();
    await tick();

    expect(server.keepAliveTimeout).toBe(5000);
    server.close();
  });

  it('still says exactly what it would change', async () => {
    const result = applySafeDefaults({ mode: 'report', http: true, log: false });
    http.createServer().close();
    await tick();

    // Both halves of the pair, because raising keepAliveTimeout without
    // raising headersTimeout with it would trip a different rule.
    expect(result.changes).toEqual([
      expect.objectContaining({
        setting: 'keepAliveTimeout',
        to: 65_000,
        applied: false,
        ruleId: 'http/keep-alive-timeout-unset',
      }),
      expect.objectContaining({ setting: 'headersTimeout', to: 66_000, applied: false }),
    ]);
  });
});

describe('logging', () => {
  it('says what it did, loudly, by default', async () => {
    // Silent behaviour modification is how a helpful library becomes a
    // three-hour debugging session six months later.
    const lines: string[] = [];
    applySafeDefaults({ mode: 'enforce', http: true, logger: (m) => lines.push(m) });
    http.createServer().close();
    await tick();

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('keepAliveTimeout = 65000');
    expect(lines[0]).toContain('http/keep-alive-timeout-unset');
    expect(lines[1]).toContain('headersTimeout = 66000');
  });

  it('distinguishes what it would do from what it did', async () => {
    const lines: string[] = [];
    applySafeDefaults({ mode: 'report', http: true, logger: (m) => lines.push(m) });
    http.createServer().close();
    await tick();

    expect(lines[0]).toContain('would set');
  });
});

describe('overrides', () => {
  it('lets a team retune one number without forking a rule', async () => {
    applySafeDefaults({
      mode: 'enforce',
      http: true,
      log: false,
      values: { 'http.keepAliveTimeout': 90_000 },
    });
    const server = http.createServer();
    await tick();

    expect(server.keepAliveTimeout).toBe(90_000);
    server.close();
  });
});

describe('profiles', () => {
  it('does not fill keepAliveTimeout on a worker, where the rule does not apply', async () => {
    applySafeDefaults({ mode: 'enforce', http: true, profile: 'worker', log: false });
    const server = http.createServer();
    await tick();

    expect(server.keepAliveTimeout).toBe(5000);
    server.close();
  });
});
