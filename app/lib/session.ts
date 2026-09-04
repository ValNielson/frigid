"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Session token storage.
 *
 * localStorage rather than an httpOnly cookie, because the deploy target is
 * Convex static hosting: there is no Node server at runtime to set one. The
 * token is still opaque, expiring, and revocable, and every Convex function
 * re-resolves it server-side, so a client can never act as an address it did
 * not prove it controls.
 */

const KEY = "frigid.sessionToken";

/** Same-tab writes, since the native `storage` event only fires in other tabs. */
const CHANGED = "frigid:session-changed";

export function readSessionToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    // Private-mode Safari and blocked site data both throw here.
    return null;
  }
}

function announce(): void {
  window.dispatchEvent(new Event(CHANGED));
}

export function writeSessionToken(token: string): void {
  try {
    window.localStorage.setItem(KEY, token);
  } catch {
    // Nothing useful to do: the user stays signed in for this page only.
  }
  announce();
}

export function clearSessionToken(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // Ignore.
  }
  announce();
}

export type SessionState =
  | { status: "loading" }
  | { status: "ready"; token: string | null };

const LOADING = Symbol("loading");
type Snapshot = string | null | typeof LOADING;

function subscribe(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  window.addEventListener(CHANGED, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(CHANGED, onChange);
  };
}

/**
 * The token, as an external store rather than state synced in an effect.
 *
 * The server snapshot is a LOADING sentinel rather than null, which is what
 * gives callers a third state to render neutrally. Without it the first paint
 * would claim "signed out" and AuthGate would bounce a signed-in user to the
 * landing page before the real value arrived.
 *
 * Subscribing also means signing out in one tab signs out the others.
 */
export function useSessionToken(): SessionState {
  const snapshot = useSyncExternalStore<Snapshot>(
    subscribe,
    useCallback(() => readSessionToken(), []),
    useCallback(() => LOADING, []),
  );

  return snapshot === LOADING
    ? { status: "loading" }
    : { status: "ready", token: snapshot };
}
