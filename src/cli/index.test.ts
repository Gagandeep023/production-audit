import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerPath, runCli } from './index';

const options = { cliDir: '/pkg/dist/cli' };

function spawnStub() {
  return vi.fn(() => ({ status: 0, signal: null, output: [], pid: 1, stdout: '', stderr: '' })) as never;
}

describe('dispatch', () => {
  it('prints usage and fails when given nothing, so a bare call is not a silent success', () => {
    const result = runCli([], options);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('production-audit');
  });

  it('prints usage and succeeds for --help', () => {
    expect(runCli(['--help'], options).exitCode).toBe(0);
  });

  it('rejects an unknown command', () => {
    expect(runCli(['audit'], options).exitCode).toBe(1);
  });
});

describe('run', () => {
  it('starts the app with our preload, not the caller own', () => {
    const spawn = spawnStub();
    runCli(['run', 'dist/server.js'], { ...options, spawn });

    const [, args] = (spawn as unknown as { mock: { calls: [string, string[]][] } }).mock.calls[0]!;
    expect(args[0]).toBe('--import');
    expect(args[1]).toBe(registerPath(options.cliDir));
    expect(args[2]).toBe('dist/server.js');
  });

  it('defaults to report mode, not enforce', () => {
    const spawn = spawnStub();
    runCli(['run', 'app.js'], { ...options, spawn });
    const call = (spawn as unknown as { mock: { calls: [string, string[], { env: Record<string, string> }][] } })
      .mock.calls[0]!;
    expect(call[2].env['PRODUCTION_AUDIT']).toBe('report');
  });

  it('passes the profile through', () => {
    const spawn = spawnStub();
    runCli(['run', '--profile', 'worker', 'app.js'], { ...options, spawn });
    const call = (spawn as unknown as { mock: { calls: [string, string[], { env: Record<string, string> }][] } })
      .mock.calls[0]!;
    expect(call[2].env['PRODUCTION_AUDIT_PROFILE']).toBe('worker');
  });

  it('forwards the application own arguments', () => {
    const spawn = spawnStub();
    runCli(['run', 'app.js', '--port', '3000'], { ...options, spawn });
    const [, args] = (spawn as unknown as { mock: { calls: [string, string[]][] } }).mock.calls[0]!;
    expect(args.slice(-2)).toEqual(['--port', '3000']);
  });

  it('rejects an unknown profile instead of quietly using the default', () => {
    expect(runCli(['run', '--profile', 'staging', 'app.js'], options).exitCode).toBe(1);
  });

  it('requires an entry file', () => {
    expect(runCli(['run'], options).exitCode).toBe(1);
  });

  it('propagates the application exit code', () => {
    const spawn = vi.fn(() => ({ status: 3 })) as never;
    expect(runCli(['run', 'app.js'], { ...options, spawn }).exitCode).toBe(3);
  });
});

describe('explain and rules', () => {
  it('explains a known rule in full', () => {
    const result = runCli(['explain', 'pg/pool-connection-timeout-unbounded'], options);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('critical');
    expect(result.stdout).toContain('applySafeDefaults writes');
  });

  it('lists the known rules when asked for one that does not exist', () => {
    const result = runCli(['explain', 'pg/made-up'], options);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('pg/pool-connection-timeout-unbounded');
  });

  it('lists the corpus worst first', () => {
    const result = runCli(['rules'], options);
    expect(result.stdout.split('\n')[0]).toContain('critical');
  });
});

describe('validate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'production-audit-'));

  it('accepts a well-formed rule file', () => {
    const file = join(dir, 'good.json');
    writeFileSync(
      file,
      JSON.stringify([
        {
          id: 'redis/no-command-timeout',
          library: 'redis',
          settings: ['commandTimeout'],
          dangerousWhen: 'unset',
          severity: 'high',
          why: 'a command with no timeout holds its connection until the server answers',
          fix: 'set commandTimeout',
        },
      ]),
    );
    expect(runCli(['validate', file], options).exitCode).toBe(0);
  });

  it('names every problem rather than only the first', () => {
    const file = join(dir, 'bad.json');
    writeFileSync(file, JSON.stringify([{ id: 'NOPE', library: 'redis' }]));
    const result = runCli(['validate', file], options);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('id');
    expect(result.stdout).toContain('severity');
  });

  it('fails clearly when the file is not there', () => {
    expect(runCli(['validate', join(dir, 'missing.json')], options).exitCode).toBe(1);
  });
});

describe('fix', () => {
  it('says it is not built yet instead of half doing it', () => {
    const result = runCli(['fix'], options);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('not implemented yet');
  });
});
