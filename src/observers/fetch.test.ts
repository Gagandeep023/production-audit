import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { list, reset } from '../core/registry';
import { configurePolicy, recordedChanges, resetPolicy } from '../core/policy';
import { installFetchObserver, uninstallFetchObserver } from './fetch';

/**
 * `fetch` is a global, so it is the one target that needs no module
 * interception and works identically under CommonJS and ESM. That is why a
 * plain `applySafeDefaults()` call covers it completely and covers `pg` only
 * partly, and why the README says so rather than rounding up.
 */

const original = globalThis.fetch;
let stub: ReturnType<typeof vi.fn>;

function fetchObservations() {
  return list().filter((o) => o.subsystem === 'fetch');
}

function enforce(timeoutMs: number): void {
  configurePolicy({
    mode: 'enforce',
    subsystems: ['fetch'],
    values: new Map([['fetch.signal', timeoutMs]]),
    rules: new Map([['fetch.signal', 'undici/fetch-no-timeout']]),
    log: false,
  });
}

beforeEach(() => {
  reset();
  resetPolicy();
  stub = vi.fn(async () => new Response('ok'));
  globalThis.fetch = stub as unknown as typeof fetch;
  installFetchObserver();
});

afterEach(() => {
  uninstallFetchObserver();
  globalThis.fetch = original;
  reset();
  resetPolicy();
});

describe('observing', () => {
  it('records a call with no signal as unset', async () => {
    await fetch('https://example.test/a');
    expect(fetchObservations()[0]!.settings['signal']).toMatchObject({ state: 'unset' });
  });

  it('records a call with a signal as explicit', async () => {
    await fetch('https://example.test/a', { signal: AbortSignal.timeout(1000) });
    expect(fetchObservations()[0]!.settings['signal']!.state).toBe('explicit');
  });

  it('records a custom dispatcher as unknown rather than as fine', async () => {
    // A dispatcher can carry headersTimeout and bodyTimeout, and Node does not
    // expose them. "Could not determine" and "nothing wrong" must never look
    // the same.
    await fetch('https://example.test/a', { dispatcher: {} } as RequestInit);
    const signal = fetchObservations()[0]!.settings['signal']!;
    expect(signal.state).toBe('unknown');
    expect(signal.note).toContain('dispatcher');
  });

  it('keys observations by call site, not by process', async () => {
    const callFromHere = () => fetch('https://example.test/a');
    const callFromThere = () => fetch('https://example.test/b');
    await callFromHere();
    await callFromThere();

    expect(fetchObservations()).toHaveLength(2);
    expect(fetchObservations()[0]!.site?.file).toContain('fetch.test.ts');
  });

  it('counts repeat calls from the same line', async () => {
    for (let i = 0; i < 3; i += 1) await fetch('https://example.test/a');
    expect(fetchObservations()).toHaveLength(1);
    expect(fetchObservations()[0]!.uses).toBe(3);
  });

  it('does not let one safe call clear a line that also calls without a signal', async () => {
    const sometimes = (withSignal: boolean) =>
      fetch('https://example.test/a', withSignal ? { signal: AbortSignal.timeout(50) } : undefined);

    await sometimes(false);
    await sometimes(true);

    expect(fetchObservations()[0]!.settings['signal']!.state).toBe('unset');
  });

  it('passes init through untouched while only observing', async () => {
    const init = { method: 'POST' };
    await fetch('https://example.test/a', init);
    expect(stub).toHaveBeenCalledWith('https://example.test/a', init);
  });
});

describe('enforcing', () => {
  it('adds a timeout to a call that passed no signal', async () => {
    enforce(2500);
    await fetch('https://example.test/a');

    const init = stub.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('never replaces a signal the caller supplied', async () => {
    enforce(2500);
    const mine = AbortSignal.timeout(9999);
    await fetch('https://example.test/a', { signal: mine });

    const init = stub.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBe(mine);
  });

  it('logs the change once per call site, not once per request', async () => {
    enforce(2500);
    for (let i = 0; i < 5; i += 1) await fetch('https://example.test/a');
    expect(recordedChanges()).toHaveLength(1);
    expect(recordedChanges()[0]).toMatchObject({ applied: true, setting: 'signal', to: 2500 });
  });
});

describe('report mode', () => {
  it('reports what it would do and changes nothing', async () => {
    configurePolicy({
      mode: 'report',
      subsystems: ['fetch'],
      values: new Map([['fetch.signal', 2500]]),
      rules: new Map([['fetch.signal', 'undici/fetch-no-timeout']]),
      log: false,
    });

    await fetch('https://example.test/a');

    expect(recordedChanges()[0]).toMatchObject({ applied: false, to: 2500 });
    expect((stub.mock.calls[0]![1] as RequestInit | undefined)?.signal).toBeUndefined();
    expect(fetchObservations()[0]!.settings['signal']!.state).toBe('unset');
  });
});
