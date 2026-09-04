"use client";

import { useRouter } from "next/navigation";
import { useAction, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { clearSessionToken, useSessionToken } from "@/app/lib/session";
import { buildOpening, realAllergies } from "@/convex/onboardingSummary";

const cardClass =
  "rounded-3xl border border-border-subtle bg-surface p-7 shadow-sm";

export function HomeScreen() {
  const router = useRouter();
  const session = useSessionToken();
  const signOut = useAction(api.verification.signOut);

  const token = session.status === "ready" ? (session.token ?? undefined) : undefined;
  const args = session.status === "ready" ? { sessionToken: token } : "skip";

  const me = useQuery(api.me.me, args);
  const prefs = useQuery(api.preferences.getMine, args);

  async function onSignOut() {
    const current = session.status === "ready" ? session.token : null;
    // Clear locally first: even if the revoke call fails, this device is out.
    clearSessionToken();
    if (current !== null) {
      try {
        await signOut({ sessionToken: current });
      } catch {
        // The token still expires on its own.
      }
    }
    router.replace("/");
  }

  const allergies = prefs ? realAllergies(prefs.answers) : [];
  const opening = prefs ? buildOpening(prefs.answers) : "";

  return (
    <div className="relative flex flex-1 flex-col px-6 py-14">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 left-1/2 h-[32rem] w-[32rem] -translate-x-1/2 rounded-full bg-frost/20 blur-3xl"
      />

      <main className="relative mx-auto w-full max-w-2xl">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.28em] text-frost">
              frigid
            </p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
              You&rsquo;re all set
            </h1>
            {me !== undefined && me !== null ? (
              <p className="mt-2 text-sm text-muted">{me.email}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onSignOut}
            className="text-sm text-muted underline-offset-4 transition hover:text-foreground hover:underline"
          >
            Sign out
          </button>
        </header>

        <div className={`${cardClass} mt-9`}>
          <h2 className="text-xs font-medium uppercase tracking-[0.16em] text-frost">
            Your taste profile
          </h2>
          {prefs === undefined ? (
            <p className="mt-4 text-muted">Loading…</p>
          ) : prefs === null ? (
            <p className="mt-4 text-muted">We don&rsquo;t have your answers yet.</p>
          ) : (
            <>
              <p className="mt-4 leading-relaxed">{opening}</p>
              {allergies.length > 0 ? (
                <p className="mt-4 rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
                  <span className="font-semibold">Allergies:</span>{" "}
                  {allergies.join(", ")} — treated as a hard rule.
                </p>
              ) : null}
              <a
                href="/onboarding?edit=1"
                className="mt-6 inline-block text-sm font-medium text-frost underline-offset-4 hover:underline"
              >
                Update my answers
              </a>
            </>
          )}
        </div>

        {/* Honest placeholders. These are the next things to build, and saying
            so beats a dashboard of buttons that do nothing. */}
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <div className={cardClass}>
            <h3 className="font-medium">What can I make tonight?</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              Tell us what&rsquo;s in the fridge and we&rsquo;ll match it against
              recipes that fit your profile. Coming next.
            </p>
          </div>
          <div className={cardClass}>
            <h3 className="font-medium">Your weekly picks</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              Seasonal ideas from the stores you shop, on the schedule you chose.
              Coming next.
            </p>
          </div>
        </div>

        <p className="mt-8 text-center text-xs text-muted">
          Every email we send has a one-click unsubscribe link.
        </p>
      </main>
    </div>
  );
}
