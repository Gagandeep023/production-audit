import type { EffectiveConfig, Finding, FindingSetting, Severity } from '../types/index';
import { SEVERITY_ORDER } from '../types/index';
import { formatCallSite } from '../core/stack';

/**
 * Level 1 is a report. Level 2 is a report you can act on without going
 * looking, which means every finding carries the location it came from and
 * the exact lines to add. Level 1 alone is honest and close to useless: the
 * developer still has to find every call site themselves.
 */

export interface FormatOptions {
  readonly color?: boolean;
  readonly cwd?: string;
  /** Set false for the short form, used by the boot-time summary. */
  readonly verbose?: boolean;
}

const ESC = String.fromCharCode(27);

const CODES: Record<string, string> = {
  reset: `${ESC}[0m`,
  dim: `${ESC}[2m`,
  bold: `${ESC}[1m`,
  red: `${ESC}[31m`,
  yellow: `${ESC}[33m`,
  blue: `${ESC}[34m`,
  green: `${ESC}[32m`,
  gray: `${ESC}[90m`,
};

const SEVERITY_COLOR: Record<Severity, string> = {
  critical: 'red',
  high: 'red',
  medium: 'yellow',
  low: 'blue',
  info: 'gray',
};

export function supportsColor(): boolean {
  if (process.env['NO_COLOR'] !== undefined) return false;
  if (process.env['FORCE_COLOR'] !== undefined) return true;
  return process.stdout.isTTY === true;
}

function paint(text: string, color: string, enabled: boolean): string {
  if (!enabled) return text;
  const code = CODES[color];
  return code === undefined ? text : `${code}${text}${CODES['reset']}`;
}

function describeValue(value: unknown): string {
  if (value === undefined) return 'unset';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value;
  return JSON.stringify(value) ?? String(value);
}

/**
 * The part of a finding a reader scans for. Says what the value is *and* what
 * it means, because `connectionTimeoutMillis = 0` reads as "fast" to anyone
 * who has not been bitten by it.
 */
function describeSetting(setting: FindingSetting): string {
  if (setting.state === 'unknown') return `${setting.name} could not be determined`;
  if (setting.state === 'unset') {
    const fallback =
      setting.libraryDefault === undefined
        ? 'unset'
        : `unset, so the library default of ${describeValue(setting.libraryDefault)} applies`;
    return `${setting.name} ${fallback}`;
  }
  return `${setting.name} = ${describeValue(setting.value)}`;
}

function wrap(text: string, width: number, indent: string): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line === '') line = word;
    else if (`${line} ${word}`.length <= width) line = `${line} ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== '') lines.push(line);
  return lines.map((l) => `${indent}${l}`);
}

export function formatFinding(finding: Finding, options: FormatOptions = {}): string {
  const color = options.color ?? false;
  const cwd = options.cwd ?? process.cwd();
  const indent = '      ';
  const lines: string[] = [];

  const label = finding.kind === 'unknown' ? 'UNKNOWN' : finding.severity.toUpperCase();
  const tag = paint(label.padEnd(8), SEVERITY_COLOR[finding.severity], color);
  const described = finding.settings.map(describeSetting);

  // One setting reads best on the headline. Several concatenated there give a
  // line nobody can scan, so they move onto their own rows instead.
  if (described.length === 1) {
    lines.push(`${tag} ${paint(finding.target, 'bold', color)} ${described[0]}`);
  } else {
    lines.push(`${tag} ${paint(finding.target, 'bold', color)} ${described.length} settings`);
    for (const setting of described) lines.push(`${indent}${setting}`);
  }
  lines.push(`${indent}${paint(finding.ruleId, 'gray', color)}`);

  if (finding.site !== undefined) {
    lines.push(`${indent}${paint(`at ${formatCallSite(finding.site, cwd)}`, 'gray', color)}`);
  }

  if (finding.kind === 'suppressed-expired') {
    lines.push(
      `${indent}${paint('suppression expired, so this is a finding again', 'yellow', color)}`,
    );
  }

  if (options.verbose !== false) {
    lines.push('');
    lines.push(...wrap(finding.why, 72, indent));

    if (finding.fixSnippet !== undefined) {
      lines.push('');
      for (const context of finding.fixSnippet.context ?? []) {
        lines.push(`${indent}${paint(`  ${context}`, 'dim', color)}`);
      }
      for (const added of finding.fixSnippet.added) {
        lines.push(`${indent}${paint(`+ ${added}`, 'green', color)}`);
      }
    } else {
      lines.push('');
      lines.push(...wrap(finding.fix, 72, indent));
    }

    if (finding.incident !== undefined) {
      lines.push('');
      lines.push(`${indent}${paint(finding.incident, 'gray', color)}`);
    }
  }

  return lines.join('\n');
}

function countBySeverity(findings: readonly Finding[]): Map<Severity, number> {
  const counts = new Map<Severity, number>();
  for (const finding of findings) {
    counts.set(finding.severity, (counts.get(finding.severity) ?? 0) + 1);
  }
  return counts;
}

export function formatSummary(findings: readonly Finding[], color = false): string {
  if (findings.length === 0) return paint('No findings.', 'green', color);

  const counts = countBySeverity(findings);
  const parts = SEVERITY_ORDER.filter((s) => counts.has(s)).map((s) =>
    paint(`${counts.get(s)} ${s}`, SEVERITY_COLOR[s], color),
  );
  const unknowns = findings.filter((f) => f.kind === 'unknown').length;
  const suffix =
    unknowns === 0
      ? ''
      : `, ${unknowns} of which could not be determined and is reported as unknown rather than passed`;
  const noun = findings.length === 1 ? 'finding' : 'findings';
  return `${findings.length} ${noun}: ${parts.join(', ')}${suffix}`;
}

/**
 * The full report.
 *
 * The "watched" line matters more than it looks: a subsystem that was armed
 * and saw nothing means the application never built one, which is a different
 * statement from "we were not looking", and a reader who cannot tell those
 * apart will trust a clean report they should not.
 */
export function formatReport(
  config: EffectiveConfig,
  findings: readonly Finding[],
  options: FormatOptions = {},
): string {
  const color = options.color ?? false;
  const sections: string[] = [];

  sections.push(paint('production-audit', 'bold', color));
  sections.push(
    paint(
      `profile ${config.profile}, node ${config.nodeVersion}, ${config.observations.length} observed`,
      'gray',
      color,
    ),
  );
  sections.push(
    paint(
      `watched: ${config.armed.length === 0 ? 'nothing' : config.armed.slice().sort().join(', ')}`,
      'gray',
      color,
    ),
  );
  sections.push('');
  sections.push(formatSummary(findings, color));

  if (findings.length > 0) {
    sections.push('');
    sections.push(findings.map((f) => formatFinding(f, options)).join('\n\n'));
  }

  const silent = config.armed.filter(
    (subsystem) => !config.observations.some((o) => o.subsystem === subsystem),
  );
  if (silent.length > 0) {
    sections.push('');
    sections.push(
      paint(
        `Watched but never exercised: ${silent.slice().sort().join(', ')}. Nothing was constructed or called, so nothing could be checked.`,
        'gray',
        color,
      ),
    );
  }

  return sections.join('\n');
}
