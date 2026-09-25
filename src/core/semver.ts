/**
 * The smallest semver range matcher that covers what rule authors write.
 *
 * The package has zero runtime dependencies, and pulling in `semver` for the
 * handful of forms that appear in a rule's `versionRange` is not worth the
 * supply-chain surface. Supported: `*`, comparators (`>=5`, `<7.2`, `=1.0.0`),
 * `^` and `~`, `x` wildcards, hyphen ranges, space-separated AND, `||` OR.
 *
 * Anything it cannot parse returns `false` from `satisfies`, so an unparseable
 * range makes a rule inert rather than making it fire on everything.
 */

export interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: string;
}

const VERSION_RE = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+](.*))?$/;

export function parseVersion(input: string): ParsedVersion | null {
  const match = VERSION_RE.exec(input.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: match[2] === undefined ? 0 : Number(match[2]),
    patch: match[3] === undefined ? 0 : Number(match[3]),
    prerelease: match[4] ?? '',
  };
}

export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  // A prerelease sorts below the release it leads to: 5.0.0-rc.1 < 5.0.0.
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === '') return 1;
  if (b.prerelease === '') return -1;
  return a.prerelease < b.prerelease ? -1 : 1;
}

interface Comparator {
  readonly op: '<' | '<=' | '>' | '>=' | '=';
  readonly version: ParsedVersion;
}

const COMPARATOR_RE = /^(<=|>=|<|>|=)?\s*(.+)$/;

/** Expands `^`, `~` and `x` wildcards into a pair of plain comparators. */
function expand(part: string): Comparator[] | null {
  const token = part.trim();
  if (token === '' || token === '*' || token === 'x' || token === 'X') return [];

  if (token.startsWith('^') || token.startsWith('~')) {
    const lower = parseVersion(token.slice(1));
    if (!lower) return null;
    const upper =
      token.startsWith('^') && lower.major > 0
        ? { major: lower.major + 1, minor: 0, patch: 0, prerelease: '' }
        : { major: lower.major, minor: lower.minor + 1, patch: 0, prerelease: '' };
    // `^0.x` is caret's special case: 0.x releases may break on the minor.
    const caretZero =
      token.startsWith('^') && lower.major === 0
        ? { major: 0, minor: lower.minor + 1, patch: 0, prerelease: '' }
        : upper;
    return [
      { op: '>=', version: lower },
      { op: '<', version: caretZero },
    ];
  }

  // `5.x` / `5.*` widen to the whole major or minor.
  const wildcard = /^(\d+)(?:\.(\d+))?\.(?:x|X|\*)$/.exec(token);
  if (wildcard) {
    const major = Number(wildcard[1]);
    if (wildcard[2] === undefined) {
      return [
        { op: '>=', version: { major, minor: 0, patch: 0, prerelease: '' } },
        { op: '<', version: { major: major + 1, minor: 0, patch: 0, prerelease: '' } },
      ];
    }
    const minor = Number(wildcard[2]);
    return [
      { op: '>=', version: { major, minor, patch: 0, prerelease: '' } },
      { op: '<', version: { major, minor: minor + 1, patch: 0, prerelease: '' } },
    ];
  }

  const match = COMPARATOR_RE.exec(token);
  if (!match) return null;
  const op = (match[1] ?? '=') as Comparator['op'];
  const raw = (match[2] ?? '').trim();
  const version = parseVersion(raw);
  if (!version) return null;

  // A bare `>=5` means `>=5.0.0`; a bare `=5` means the whole 5.x line.
  if (op === '=' && !raw.includes('.')) {
    return [
      { op: '>=', version },
      { op: '<', version: { major: version.major + 1, minor: 0, patch: 0, prerelease: '' } },
    ];
  }
  return [{ op, version }];
}

function parseAnd(clause: string): Comparator[] | null {
  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(clause.trim());
  if (hyphen) {
    const lower = parseVersion(hyphen[1] as string);
    const upper = parseVersion(hyphen[2] as string);
    if (!lower || !upper) return null;
    return [
      { op: '>=', version: lower },
      { op: '<=', version: upper },
    ];
  }

  const out: Comparator[] = [];
  for (const part of clause.split(/\s+/)) {
    if (part === '') continue;
    const expanded = expand(part);
    if (expanded === null) return null;
    out.push(...expanded);
  }
  return out;
}

function test(version: ParsedVersion, comparator: Comparator): boolean {
  const cmp = compareVersions(version, comparator.version);
  switch (comparator.op) {
    case '<':
      return cmp < 0;
    case '<=':
      return cmp <= 0;
    case '>':
      return cmp > 0;
    case '>=':
      return cmp >= 0;
    case '=':
      return cmp === 0;
  }
}

/**
 * True when `version` falls inside `range`. An empty or `*` range matches
 * everything; an unparseable version or range matches nothing.
 */
export function satisfies(version: string, range: string): boolean {
  const trimmedRange = range.trim();
  if (trimmedRange === '' || trimmedRange === '*') return true;

  const parsed = parseVersion(version);
  if (!parsed) return false;

  for (const clause of trimmedRange.split('||')) {
    const comparators = parseAnd(clause);
    if (comparators === null) continue;
    if (comparators.every((c) => test(parsed, c))) return true;
  }
  return false;
}
