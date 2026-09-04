/**
 * Session-token hashing, deliberately runtime-agnostic.
 *
 * verification.ts hashes codes with node:crypto because it is already a "use
 * node" module. Session tokens cannot do that: the `me` query has to hash an
 * incoming token to look it up, and it runs in Convex's default runtime where
 * node:crypto does not exist. Web Crypto is present in both runtimes, so this
 * one async helper is what mints and what resolves, and the two can never drift.
 *
 * Uses the same VERIFICATION_CODE_PEPPER as the code hashing. Different input
 * shape (`token:pepper` vs `code:pepper`) keeps the two digest spaces distinct.
 */
export async function hashSessionToken(
  token: string,
  pepper: string,
): Promise<string> {
  const bytes = new TextEncoder().encode(`${token}:${pepper}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
