"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useSessionToken } from "@/app/lib/session";

/**
 * The one place routing decisions live.
 *
 *   not verified            -> "/"            (verify your email)
 *   verified, not onboarded -> "/onboarding"
 *   verified and onboarded  -> "/home"
 *
 * "Onboarded but not verified" is not handled here because it cannot exist:
 * onboardedAt is only written by a mutation that already resolved a session,
 * and sessions are only minted by a successful verification.
 *
 * The `me` query is reactive, so finishing onboarding or signing out in one tab
 * moves every other tab without a reload.
 */

export type Requirement =
  | "anon"
  /** Verified but not yet onboarded: the first run through the quiz. */
  | "verified"
  /** Verified, onboarded or not: re-taking the quiz to edit answers. */
  | "verified-any"
  | "onboarded";

function destinationFor(
  me: { verified: boolean; onboarded: boolean } | null,
): string {
  if (me === null) return "/";
  if (!me.verified) return "/";
  return me.onboarded ? "/home" : "/onboarding";
}

function satisfies(
  requirement: Requirement,
  me: { verified: boolean; onboarded: boolean } | null,
): boolean {
  switch (requirement) {
    case "anon":
      return me === null;
    case "verified":
      // A fully onboarded user does not belong on the first-run quiz; they get
      // sent to /home, and reach it again only with an explicit edit intent.
      return me !== null && me.verified && !me.onboarded;
    case "verified-any":
      return me !== null && me.verified;
    case "onboarded":
      return me !== null && me.verified && me.onboarded;
  }
}

export function AuthGate({
  require: requirement,
  children,
}: {
  require: Requirement;
  children: ReactNode;
}) {
  const router = useRouter();
  const session = useSessionToken();

  // Skip the query entirely until the token has hydrated, so we never ask the
  // server "who is token undefined" and briefly render a signed-out answer.
  const me = useQuery(
    api.me.me,
    session.status === "ready"
      ? { sessionToken: session.token ?? undefined }
      : "skip",
  );

  const loading = session.status !== "ready" || me === undefined;
  const allowed = !loading && satisfies(requirement, me ?? null);

  useEffect(() => {
    if (loading || allowed) return;
    router.replace(destinationFor(me ?? null));
  }, [loading, allowed, me, router]);

  if (loading || !allowed) return <GateSkeleton />;
  return <>{children}</>;
}

/** Neutral placeholder. Deliberately says nothing about who is signed in. */
function GateSkeleton() {
  return (
    <div className="flex flex-1 items-center justify-center px-6 py-16">
      <div
        className="h-8 w-8 animate-spin rounded-full border-2 border-border-subtle border-t-frost"
        role="status"
        aria-label="Loading"
      />
    </div>
  );
}
