import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { list, reset } from '../core/registry';
import { configurePolicy, resetPolicy, recordedChanges } from '../core/policy';
import { wrapPgExports } from './pgPool';

/**
 * `pg` is not a dependency of this package and must not become one, so the
 * tests wrap a stand-in module with the same shape. What is being tested is
 * the interception, not `pg` itself.
 */

class FakePool {
  public readonly options: Record<string, unknown> | undefined;
  public static readonly staticMarker = 'kept';

  constructor(options?: Record<string, unknown>) {
    this.options = options;
  }

  query(): string {
    return 'rows';
  }
}

function makeModule() {
  return wrapPgExports({ Pool: FakePool, Client: class {} }, '8.13.1') as {
    Pool: typeof FakePool;
  };
}

function pools() {
  return list().filter((o) => o.subsystem === 'pg');
}

beforeEach(() => {
  reset();
  resetPolicy();
});

afterEach(() => {
  reset();
  resetPolicy();
});

describe('wrapping', () => {
  it('records the options the developer passed, with the version and the call site', () => {
    const pg = makeModule();
    new pg.Pool({ connectionString: 'postgres://x', connectionTimeoutMillis: 5000 });

    const pool = pools()[0]!;
    expect(pool.target).toBe('pg.Pool');
    expect(pool.libraryVersion).toBe('8.13.1');
    expect(pool.site?.file).toContain('pgPool.test.ts');
    expect(pool.settings['connectionTimeoutMillis']).toMatchObject({
      state: 'explicit',
      value: 5000,
    });
  });

  it('marks what was not passed as unset, with pg own default', () => {
    const pg = makeModule();
    new pg.Pool({ connectionString: 'postgres://x' });

    expect(pools()[0]!.settings['connectionTimeoutMillis']).toEqual({
      state: 'unset',
      value: 0,
      libraryDefault: 0,
    });
    expect(pools()[0]!.settings['idleTimeoutMillis']!.libraryDefault).toBe(10000);
  });

  it('treats an explicit undefined as absent, because pg does', () => {
    const pg = makeModule();
    new pg.Pool({ connectionTimeoutMillis: undefined });
    expect(pools()[0]!.settings['connectionTimeoutMillis']!.state).toBe('unset');
  });

  it('handles a pool constructed with no options at all', () => {
    const pg = makeModule();
    new pg.Pool();
    expect(pools()[0]!.settings['max']!.state).toBe('unset');
  });
});

describe('not breaking the thing it wraps', () => {
  it('keeps instanceof working', () => {
    const pg = makeModule();
    const pool = new pg.Pool();
    expect(pool).toBeInstanceOf(pg.Pool);
    expect(pool).toBeInstanceOf(FakePool);
  });

  it('keeps statics and prototype methods', () => {
    const pg = makeModule();
    expect(pg.Pool.staticMarker).toBe('kept');
    expect(new pg.Pool().query()).toBe('rows');
  });

  it('passes the original options through when no policy is configured', () => {
    const pg = makeModule();
    const pool = new pg.Pool({ connectionString: 'postgres://x' });
    expect(pool.options).toEqual({ connectionString: 'postgres://x' });
  });

  it('leaves a module without a Pool alone', () => {
    expect(wrapPgExports({ Client: class {} }, '8.13.1')).toEqual({ Client: expect.anything() });
    expect(wrapPgExports(null, undefined)).toBeNull();
  });
});

describe('filling defaults', () => {
  function policy(mode: 'report' | 'enforce') {
    configurePolicy({
      mode,
      subsystems: ['pg'],
      values: new Map([
        ['pg.connectionTimeoutMillis', 5000],
        ['pg.statement_timeout', 30000],
      ]),
      rules: new Map([
        ['pg.connectionTimeoutMillis', 'pg/pool-connection-timeout-unbounded'],
        ['pg.statement_timeout', 'pg/no-statement-timeout'],
      ]),
      log: false,
    });
  }

  it('merges safe values into the options before the pool exists', () => {
    policy('enforce');
    const pg = makeModule();
    const pool = new pg.Pool({ connectionString: 'postgres://x' });

    expect(pool.options).toMatchObject({
      connectionString: 'postgres://x',
      connectionTimeoutMillis: 5000,
      statement_timeout: 30000,
    });
  });

  it('never overrides a value the developer chose, including a deliberate 0', () => {
    // A deliberate `connectionTimeoutMillis: 0` stands, because the developer
    // meant it. The audit still reports it; filling it in would not.
    policy('enforce');
    const pg = makeModule();
    const pool = new pg.Pool({ connectionTimeoutMillis: 0 });

    expect(pool.options!['connectionTimeoutMillis']).toBe(0);
    expect(recordedChanges().map((c) => c.setting)).toEqual(['statement_timeout']);
  });

  it('marks a filled value as configured but notes that we filled it', () => {
    policy('enforce');
    const pg = makeModule();
    new pg.Pool({});

    const setting = pools()[0]!.settings['connectionTimeoutMillis']!;
    expect(setting.state).toBe('explicit');
    expect(setting.note).toBe('filled by production-audit');
  });

  it('report mode changes nothing and still says what it would change', () => {
    policy('report');
    const pg = makeModule();
    const pool = new pg.Pool({ connectionString: 'postgres://x' });

    expect(pool.options).toEqual({ connectionString: 'postgres://x' });
    expect(recordedChanges().every((c) => c.applied === false)).toBe(true);
    expect(recordedChanges()).toHaveLength(2);
  });

  it('does nothing for a subsystem that was not opted into', () => {
    configurePolicy({
      mode: 'enforce',
      subsystems: ['http'],
      values: new Map([['pg.connectionTimeoutMillis', 5000]]),
      rules: new Map([['pg.connectionTimeoutMillis', 'pg/pool-connection-timeout-unbounded']]),
      log: false,
    });
    const pg = makeModule();
    const pool = new pg.Pool({});

    expect(pool.options).toEqual({});
    expect(recordedChanges()).toEqual([]);
  });
});
