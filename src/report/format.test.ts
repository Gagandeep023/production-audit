import { describe, expect, it } from 'vitest';
import { formatFinding, formatReport, formatSummary } from './format';
import { toJsonReport } from './json';
import { evaluate } from '../core/evaluate';
import { builtinRules } from '../rules/index';
import {
  configuredPool,
  defaultPool,
  defaultServer,
  effective,
  fetchSite,
  unknown,
} from '../core/__fixtures__/observations';

const rules = builtinRules();

describe('a finding', () => {
  const finding = evaluate(effective([defaultPool()]), { rules })[0]!;
  const text = formatFinding(finding, { cwd: '/app' });

  it('leads with the severity, the target and the value', () => {
    expect(text.split('\n')[0]).toContain('CRITICAL');
    expect(text.split('\n')[0]).toContain('pg.Pool');
    expect(text.split('\n')[0]).toContain('connectionTimeoutMillis');
  });

  it('says what the default does, because 0 reads as fast to anyone unbitten', () => {
    expect(text).toContain('the library default of 0 applies');
  });

  it('carries the location, which is what makes it actionable', () => {
    expect(text).toContain('at src/db/index.ts:14');
  });

  it('shows the fix as a diff, not as prose to translate', () => {
    expect(text).toContain('+   connectionTimeoutMillis: 5_000,');
    expect(text).toContain('  new Pool({');
  });

  it('names the rule so it can be suppressed or explained', () => {
    expect(text).toContain('pg/pool-connection-timeout-unbounded');
  });

  it('has a short form for the boot-time summary', () => {
    const short = formatFinding(finding, { verbose: false });
    expect(short).not.toContain('connectionTimeoutMillis: 5_000');
    expect(short.split('\n').length).toBeLessThan(5);
  });
});

describe('an unknown finding', () => {
  it('is labelled UNKNOWN rather than by severity, so it cannot read as a pass', () => {
    const finding = evaluate(effective([fetchSite(unknown('a custom dispatcher was passed'))]), {
      rules,
    })[0]!;
    const text = formatFinding(finding);
    expect(text).toContain('UNKNOWN');
    expect(text).toContain('could not be determined');
  });
});

describe('the summary', () => {
  it('says nothing is wrong when nothing is', () => {
    expect(formatSummary([])).toBe('No findings.');
  });

  it('counts by severity', () => {
    const findings = evaluate(effective([defaultPool(), defaultServer()]), { rules });
    expect(formatSummary(findings)).toMatch(/^\d+ findings: /);
  });

  it('calls out how many could not be determined', () => {
    const findings = evaluate(effective([fetchSite(unknown('no'))]), { rules });
    expect(formatSummary(findings)).toContain('could not be determined');
  });
});

describe('the report', () => {
  it('separates "nothing was there" from "we were not looking"', () => {
    // A reader who cannot tell those apart will trust a clean report they
    // should not.
    const config = effective([configuredPool()]);
    const text = formatReport(config, []);

    expect(text).toContain('watched: fetch, http, pg');
    expect(text).toContain('Watched but never exercised: fetch, http');
  });

  it('says nothing more when everything was checked and passed', () => {
    const config = {
      ...effective([configuredPool()]),
      armed: ['pg'] as const,
    };
    const text = formatReport(config, []);
    expect(text).toContain('No findings.');
    expect(text).not.toContain('never exercised');
  });

  it('emits no escape codes when colour is off', () => {
    const findings = evaluate(effective([defaultPool()]), { rules });
    const text = formatReport(effective([defaultPool()]), findings, { color: false });
    expect(text).not.toContain(String.fromCharCode(27));
  });
});

describe('the json report', () => {
  const config = effective([defaultPool()]);
  const json = toJsonReport(config, evaluate(config, { rules }), '/app');

  it('is versioned, so a consumer can depend on the shape', () => {
    expect(json.version).toBe(1);
  });

  it('includes the observations, not only the findings', () => {
    // A run that reports nothing because it observed nothing looks identical
    // to a clean one unless the consumer can see what was there.
    expect(json.observations).toHaveLength(1);
    expect(json.observations[0]!.settings['connectionTimeoutMillis']).toMatchObject({
      state: 'unset',
    });
  });

  it('gives each finding a repo-relative location', () => {
    expect(json.findings[0]!.at).toBe('src/db/index.ts:14');
  });

  it('counts by severity', () => {
    expect(json.counts['critical']).toBe(1);
  });
});
