import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { list, reset } from '../core/registry';
import { resetPolicy } from '../core/policy';
import {
  installHttpServerObserver,
  uninstallHttpServerObserver,
  wasAssigned,
} from './httpServer';

/**
 * The assignment-tracking tests. This is the mechanism the entire "never
 * override an explicit choice" guarantee rests on, so it is tested against a
 * real `http.Server` rather than a stand-in.
 */

function latest() {
  const observations = list().filter((o) => o.subsystem === 'http');
  return observations[observations.length - 1]!;
}

beforeEach(() => {
  reset();
  resetPolicy();
  installHttpServerObserver();
});

afterEach(() => {
  uninstallHttpServerObserver();
  reset();
  resetPolicy();
});

describe('observing a server', () => {
  it('records one observation per server, with the call site', () => {
    const server = http.createServer();
    const observation = latest();

    expect(observation.target).toBe('http.Server');
    expect(observation.library).toBe('node');
    expect(observation.site?.file).toContain('httpServer.test.ts');
    server.close();
  });

  it('marks untouched settings unset, and says what the default does', () => {
    const server = http.createServer();
    expect(latest().settings['keepAliveTimeout']).toEqual({
      state: 'unset',
      value: 5000,
      libraryDefault: 5000,
    });
    server.close();
  });

  it('counts a constructor option as explicit', () => {
    const server = http.createServer({ keepAliveTimeout: 61_000 });
    expect(latest().settings['keepAliveTimeout']).toMatchObject({
      state: 'explicit',
      value: 61_000,
    });
    server.close();
  });

  it('counts an option key as explicit even when its value is the default', () => {
    // The presence of the key is the choice. Judging by value would call this
    // untouched and then overwrite it.
    const server = http.createServer({ keepAliveTimeout: 5000 });
    expect(latest().settings['keepAliveTimeout']!.state).toBe('explicit');
    server.close();
  });

  it('counts a post-construction assignment as explicit', () => {
    const server = http.createServer();
    server.keepAliveTimeout = 65_000;

    expect(latest().settings['keepAliveTimeout']).toMatchObject({
      state: 'explicit',
      value: 65_000,
    });
    expect(wasAssigned(server, 'keepAliveTimeout')).toBe(true);
    server.close();
  });

  it('counts an assignment equal to the default as explicit', () => {
    // The hardest case in the package: `= 5000` on a setting that defaults to
    // 5000 is indistinguishable by value from never touching it.
    const server = http.createServer();
    server.keepAliveTimeout = 5000;

    expect(latest().settings['keepAliveTimeout']!.state).toBe('explicit');
    expect(wasAssigned(server, 'keepAliveTimeout')).toBe(true);
    server.close();
  });

  it('counts server.setTimeout as explicit, because it is a choice', () => {
    const server = http.createServer();
    server.setTimeout(20_000);
    expect(latest().settings['timeout']).toMatchObject({ state: 'explicit', value: 20_000 });
    server.close();
  });

  it('leaves the other settings alone when one is assigned', () => {
    const server = http.createServer();
    server.keepAliveTimeout = 65_000;

    expect(latest().settings['requestTimeout']!.state).toBe('unset');
    server.close();
  });
});

describe('not breaking the thing it watches', () => {
  it('the getter returns the real value and the server still serves', async () => {
    const server = http.createServer((_req, res) => {
      res.end('ok');
    });
    server.keepAliveTimeout = 7000;
    expect(server.keepAliveTimeout).toBe(7000);

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/`);

    expect(await response.text()).toBe('ok');
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('is idempotent, so a second install does not double-wrap', () => {
    installHttpServerObserver();
    installHttpServerObserver();
    const server = http.createServer();
    expect(list().filter((o) => o.subsystem === 'http')).toHaveLength(1);
    server.close();
  });
});
