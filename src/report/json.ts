import type { EffectiveConfig, Finding } from '../types/index';
import { formatCallSite } from '../core/stack';

/**
 * Machine-readable output, for CI and for anything that wants to diff two
 * runs. Kept separate from the text formatter so the shape is a contract
 * rather than a by-product of how the report happens to print today.
 *
 * Observations are included, not just findings. A run that reports nothing
 * because it observed nothing looks identical to a clean one unless the
 * consumer can see what was actually there.
 */

export interface JsonFinding {
  readonly ruleId: string;
  readonly kind: string;
  readonly severity: string;
  readonly target: string;
  readonly library: string;
  readonly libraryVersion?: string;
  readonly at?: string;
  readonly settings: readonly { name: string; state: string; value?: unknown }[];
  readonly why: string;
  readonly fix: string;
  readonly incident?: string;
}

export interface JsonObservation {
  readonly id: string;
  readonly subsystem: string;
  readonly target: string;
  readonly library: string;
  readonly libraryVersion?: string;
  readonly at?: string;
  readonly uses?: number;
  readonly settings: Readonly<Record<string, { state: string; value?: unknown; note?: string }>>;
}

export interface JsonReport {
  readonly version: 1;
  readonly profile: string;
  readonly nodeVersion: string;
  readonly collectedAt: string;
  readonly watched: readonly string[];
  readonly counts: Readonly<Record<string, number>>;
  readonly findings: readonly JsonFinding[];
  readonly observations: readonly JsonObservation[];
}

export function toJsonReport(
  config: EffectiveConfig,
  findings: readonly Finding[],
  cwd = process.cwd(),
): JsonReport {
  const counts: Record<string, number> = {};
  for (const finding of findings) {
    counts[finding.severity] = (counts[finding.severity] ?? 0) + 1;
  }

  return {
    version: 1,
    profile: config.profile,
    nodeVersion: config.nodeVersion,
    collectedAt: new Date(config.collectedAt).toISOString(),
    watched: config.armed.slice().sort(),
    counts,
    findings: findings.map((finding) => ({
      ruleId: finding.ruleId,
      kind: finding.kind,
      severity: finding.severity,
      target: finding.target,
      library: finding.library,
      libraryVersion: finding.libraryVersion,
      at: finding.site === undefined ? undefined : formatCallSite(finding.site, cwd),
      settings: finding.settings.map((s) => ({
        name: s.name,
        state: s.state,
        value: s.value,
      })),
      why: finding.why,
      fix: finding.fix,
      incident: finding.incident,
    })),
    observations: config.observations.map((observation) => ({
      id: observation.id,
      subsystem: observation.subsystem,
      target: observation.target,
      library: observation.library,
      libraryVersion: observation.libraryVersion,
      at: observation.site === undefined ? undefined : formatCallSite(observation.site, cwd),
      uses: observation.uses,
      settings: Object.fromEntries(
        Object.entries(observation.settings).map(([name, setting]) => [
          name,
          { state: setting.state, value: setting.value, note: setting.note },
        ]),
      ),
    })),
  };
}
