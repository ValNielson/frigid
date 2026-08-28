export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing ${name}. Add it to this Convex deployment's environment variables.`,
    );
  }
  return value;
}
