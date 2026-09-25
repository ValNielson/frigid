export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing ${name}. Add it to this Convex deployment's environment variables.`,
    );
  }
  return value;
}

/**
 * Reads a setting that has a sensible default.
 *
 * Kept here alongside requireEnv so the backend still has exactly one place
 * that touches process.env, which is what makes the deployment's configuration
 * greppable.
 */
export function optionalEnv(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

/**
 * A numeric setting that a deployment may raise or lower without a code change.
 *
 * Exists for the limits that are a judgement call rather than a fact about the
 * world — the daily credit ceiling and the per-user search cap. Both are set
 * conservatively so an ordinary day cannot burn the month, and both need to
 * come off for a demo where strangers are using the app at once. An env
 * override means that is a one-line change on the deployment and a one-line
 * revert, rather than an edit someone has to remember to undo.
 *
 * A missing or unparseable value falls back rather than throwing: a typo in a
 * deployment variable should not take the app down.
 */
export function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
