import { sep } from 'node:path';
import type { CallSite } from '../types/index';

/**
 * A finding that says "some pool somewhere has no timeout" is true and
 * useless. The call site is what makes the report actionable, so every
 * construction observer captures one.
 *
 * The frames belonging to this package are removed by `Error.captureStackTrace`
 * rather than by matching paths: the observer hands in the outermost of its
 * own functions, and V8 drops that frame and everything above it. Matching on
 * paths was tried first and is subtly wrong, because a user's own project
 * directory can share a name with ours.
 */

const FRAME_RE = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/;

function isInternal(frame: string): boolean {
  return frame.includes('node:') || frame.includes('node:internal');
}

function isDependency(frame: string): boolean {
  return frame.includes(`${sep}node_modules${sep}`);
}

function toCallSite(frame: string): CallSite | undefined {
  const match = FRAME_RE.exec(frame);
  if (!match) return undefined;
  return {
    file: match[2] as string,
    line: Number(match[3]),
    column: Number(match[4]),
    frame: frame.trim(),
  };
}

/**
 * Picks the first frame that belongs to the application.
 *
 * Preference order is application code, then a dependency, then whatever is
 * left. A pool constructed inside a framework still deserves a location, even
 * though it is one the developer cannot edit directly.
 *
 * `skipAbove` must be the observer's own outermost function, the one the
 * application called. Everything from it upwards is dropped.
 */
export function captureCallSite(skipAbove?: (...args: never[]) => unknown): CallSite | undefined {
  const holder: { stack?: string } = {};
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 30;
  if (skipAbove === undefined) Error.captureStackTrace(holder);
  else Error.captureStackTrace(holder, skipAbove);
  Error.stackTraceLimit = limit;

  const frames = (holder.stack ?? '')
    .split('\n')
    .slice(1)
    .filter((line) => line.trim().startsWith('at '));

  const candidates = frames.filter((f) => !isInternal(f));
  const application = candidates.find((f) => !isDependency(f));
  const chosen = application ?? candidates[0] ?? frames[0];
  return chosen === undefined ? undefined : toCallSite(chosen);
}

/** `src/db/index.ts:14`, or the raw frame when it could not be parsed. */
export function formatCallSite(site: CallSite, cwd = process.cwd()): string {
  let file = site.file;
  if (file.startsWith('file://')) file = file.slice('file://'.length);
  if (file.startsWith(`${cwd}${sep}`)) file = file.slice(cwd.length + 1);
  return site.line === undefined ? file : `${file}:${site.line}`;
}
