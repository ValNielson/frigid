// Shared, runtime-agnostic policy for email verification. Imported by both the
// default-runtime mutations in users.ts and the "use node" actions in
// verification.ts, so it must stay free of Node and Convex imports.

export const CODE_LENGTH = 6;
export const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
export const MAX_VERIFY_ATTEMPTS = 5;
export const RESEND_COOLDOWN_MS = 60 * 1000; // 1 minute between sends
export const SEND_WINDOW_MS = 60 * 60 * 1000; // rolling hour
export const MAX_SENDS_PER_WINDOW = 5;

// Deliberately permissive. Real validation is "did the code arrive", so this
// only rejects input that could never be an address.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Returns the normalized address, or null if it cannot be one. */
export function normalizeEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (email.length === 0 || email.length > 254) return null;
  if (!EMAIL_PATTERN.test(email)) return null;
  return email;
}

/**
 * Length-independent comparison for equal-length hex digests. Node's
 * timingSafeEqual is unavailable in Convex's default runtime, where the
 * comparison has to happen, so this is the portable equivalent.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
