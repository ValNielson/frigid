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
