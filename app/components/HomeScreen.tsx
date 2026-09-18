"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useSessionToken } from "@/app/lib/session";
import { buildOpening, realAllergies } from "@/convex/onboardingSummary";
import { AppHeader } from "./AppHeader";
import { DealsRunCard } from "./DealsRunCard";
import { RecipeSearchCard } from "./RecipeSearchCard";
import { AllergyNotice, linkClass } from "./ui";

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Morning";
  if (hour < 17) return "Afternoon";
  return "Evening";
}

export function HomeScreen() {
  const session = useSessionToken();
  const args =
    session.status === "ready" ? { sessionToken: session.token ?? undefined } : "skip";
  const prefs = useQuery(api.preferences.getMine, args);
  // Fixed at mount: a greeting that flips mid-visit reads as a glitch.
  const [hello] = useState(greeting);

  const allergies = prefs ? realAllergies(prefs.answers) : [];
  const opening = prefs ? buildOpening(prefs.answers) : "";

  return (
    <div className="flex flex-1 flex-col">
      <AppHeader />

      <main className="relative flex-1">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-80 bg-gradient-to-b from-mint to-transparent"
        />

        <div className="relative mx-auto flex w-full max-w-[860px] flex-col gap-10 px-4 pt-10 pb-14 sm:px-10">
          <section className="flex flex-col gap-4">
            <h1 className="text-3xl font-semibold tracking-[-0.025em] sm:text-[34px]">
              {hello}. What are we cooking?
            </h1>
            <RecipeSearchCard />
          </section>

          <div className="grid gap-8 md:grid-cols-[1.6fr_1fr]">
            <section className="flex flex-col gap-3">
              <div className="flex items-baseline justify-between gap-4">
                <h2 className="slab">Your taste profile</h2>
                <Link href="/onboarding?edit=1" className={`${linkClass} text-sm`}>
                  Update my answers
                </Link>
              </div>
              {prefs === undefined ? (
                <p className="text-muted">Loading…</p>
              ) : prefs === null ? (
                <p className="text-muted">We don&rsquo;t have your answers yet.</p>
              ) : (
                <>
                  <p className="text-base leading-relaxed">{opening}</p>
                  {allergies.length > 0 ? (
                    <AllergyNotice title={`Allergies: ${allergies.join(", ")}.`}>
                      Treated as a hard rule, never a preference.
                    </AllergyNotice>
                  ) : null}
                </>
              )}
            </section>

            <section className="flex flex-col gap-3">
              <h2 className="slab">This week&rsquo;s picks</h2>
              <DealsRunCard />
            </section>
          </div>

          <p className="text-center text-xs text-subtle">
            Every email we send has a one-click unsubscribe link.
          </p>
        </div>
      </main>
    </div>
  );
}
