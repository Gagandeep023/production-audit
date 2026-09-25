import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * End to end, in a real child process, under the real preload.
 *
 * Everything else in the suite tests a piece with the rest held still. This
 * one is the only place where `Module._load` interception, the
 * `diagnostics_channel` subscription, the accessor-based assignment tracking
 * and the report all have to work at once, in the order a booting application
 * puts them in. It runs against `dist`, because that is what people install.
 */

const root = join(__dirname, '..');
const register = join(root, 'dist', 'register.js');
const fixtures = join(root, 'test', 'fixtures');

function run(entry: string, env: Record<string, string> = {}): string {
  const result = spawnSync(process.execPath, ['--import', register, join(fixtures, entry)], {
    cwd: fixtures,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 20_000,
  });
  return `${result.stdout}\n${result.stderr}`;
}

/**
 * The report only, with the boot-time change log stripped off. Those log lines
 * name the rule that caused each change, so asserting a rule is absent from
 * the whole output would pass or fail for the wrong reason.
 */
function reportOnly(output: string): string {
  const start = output.lastIndexOf('\nprofile ');
  return start === -1 ? output : output.slice(start);
}

describe.runIf(existsSync(register))('a default-configured app under the preload', () => {
  const output = run('app.cjs');

  it('finds the pool that will queue forever', () => {
    expect(output).toContain('pg/pool-connection-timeout-unbounded');
    expect(output).toContain('CRITICAL');
  });

  it('points at the line that built it', () => {
    // Intercepting the constructor rather than reading config afterwards is
    // what buys this, and it is the difference between a true report and a
    // useful one.
    expect(output).toMatch(/at app\.cjs:\d+/);
  });

  it('resolves the installed version, so version-scoped rules can apply', () => {
    // The pg rules are scoped to >=8. If the version could not be read they
    // would go inert and this whole section would pass by accident.
    expect(output).toContain('pg/no-statement-timeout');
  });

  it('finds the fetch call with no timeout', () => {
    expect(output).toContain('undici/fetch-no-timeout');
  });

  it('finds the server whose keep-alive nobody considered', () => {
    expect(output).toContain('http/keep-alive-timeout-unset');
  });

  it('shows the fix as lines to add', () => {
    expect(output).toContain('+   connectionTimeoutMillis: 5_000,');
  });

  it('observed the outbound request through diagnostics_channel as well', () => {
    // The channel observation is recorded only when a message actually
    // arrives, so a fourth observation is what proves the subscription fired.
    // It carries no finding of its own by design: undici publishes the
    // request but not the dispatcher, so its timeouts stay unknown and the
    // actionable check comes from the fetch observer instead.
    expect(output).toContain('watched: fetch, http, pg, undici');
    expect(output).toMatch(/4 observed/);
  });
});

describe.runIf(existsSync(register))('an explicitly configured app', () => {
  /**
   * The most important assertion in the package. Everything above is worth
   * nothing if the tool also fires on an application that already did the
   * work, because that application mutes it and never turns it back on.
   */
  it('produces no findings at all', () => {
    const output = run('configured.cjs');
    expect(output).toContain('No findings.');
  });

  it('still reports what it watched, so silence is legible', () => {
    const output = run('configured.cjs');
    expect(output).toContain('watched:');
  });
});

describe.runIf(existsSync(register))('enforce mode', () => {
  const output = run('app.cjs', { PRODUCTION_AUDIT: 'enforce' });

  it('says out loud what it changed', () => {
    expect(output).toContain('production-audit: set');
    expect(output).toContain('connectionTimeoutMillis = 5000');
  });

  it('clears the findings it fixed', () => {
    const report = reportOnly(output);
    expect(report).not.toContain('pg/pool-connection-timeout-unbounded');
    expect(report).not.toContain('http/keep-alive-timeout-unset');
  });

  it('does not create a finding of its own', () => {
    // Raising keepAliveTimeout without raising headersTimeout with it trips
    // http/headers-timeout-below-keep-alive. A reliability tool that causes
    // the incident is worse than no tool, so the pair moves together.
    expect(reportOnly(output)).toContain('No findings.');
  });
});

describe.runIf(existsSync(register))('report mode', () => {
  it('says what it would change and leaves the findings standing', () => {
    const output = run('app.cjs', { PRODUCTION_AUDIT: 'report' });
    expect(output).toContain('production-audit: would set');
    expect(reportOnly(output)).toContain('pg/pool-connection-timeout-unbounded');
  });
});

describe.runIf(existsSync(register))('staying out of the way', () => {
  it('can be silenced completely', () => {
    const output = run('app.cjs', { PRODUCTION_AUDIT_REPORT: 'off' });
    expect(output).not.toContain('production-audit');
  });
});
