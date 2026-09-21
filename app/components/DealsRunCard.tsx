"use client";

import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import { useSessionToken } from "@/app/lib/session";
import { panelClass } from "@/app/lib/formClasses";

type Run = NonNullable<FunctionReturnType<typeof api.deals.latestRun>>;

/**
 * What a run's outcome means in one line.
 *
 * Zero matches is a real answer, not a failure: the profile and the week's
 * coupons genuinely did not overlap.
 */
function outcome(run: Run): string {
  if (run.status === "skipped") {
    return "Paused for today — we had spent this day's budget for reading store pages.";
  }
  if (run.couponsMatched === 0) {
    return "Nothing worth sending this time. The stores near you are not discounting anything that suits your profile.";
  }
  const plural = run.couponsMatched === 1 ? "deal" : "deals";
  // A run started by a recipe search suppresses its own digest on purpose —
  // the deals ride along in the recipe email instead. Claiming a second email
  // that was never sent is worse than saying nothing about where they went.
  return run.kind === "ingredients"
    ? `${run.couponsMatched} ${plural} matched to your shopping list.`
    : `${run.couponsMatched} ${plural} matched to your profile, sent to your email.`;
}

/**
 * Whether the run came from a recipe search or from the schedule.
 *
 * The last line is for rows left by the Ask screen, which started runs of its
 * own before the kitchen panel became the only composer.
 */
function origin(run: Run): string {
  if (run.trigger === "cron") return "Your scheduled look for deals";
  if (run.kind === "ingredients") return "Deals for your shopping list";
  return "Your last look for deals";
}

/** The latest run, whoever started it: a cron digest or a recipe search. */
function useLatestRun(): Run | null | undefined {
  const session = useSessionToken();
  const args =
    session.status === "ready" ? { sessionToken: session.token ?? undefined } : "skip";
  return useQuery(api.deals.latestRun, args);
}

/** True while a run is genuinely working, as opposed to finished or wedged. */
function isRunning(run: Run | null | undefined): boolean {
  return run?.status === "running" && !run.stalled;
}

/**
 * The home page's deals slot.
 *
 * Deliberately small. The recipe search card owns the progress of the search
 * the user just started, heartbeat and all; this reports the deals run behind
 * it, and keeps its honest "coming next" copy until there is one to report.
 */
export function DealsRunCard() {
  const run = useLatestRun();

  if (run === undefined || run === null) {
    return (
      <div className={panelClass}>
        <p className="font-medium">Coming next</p>
        <p className="mt-1.5 text-sm leading-relaxed text-muted">
          Seasonal ideas from the stores you shop, on the schedule you chose.
        </p>
      </div>
    );
  }

  const running = isRunning(run);
  const broken = run.status === "failed" || run.stalled;
  const message = run.stalled
    ? "This run stopped responding. Start another one when you're ready."
    : run.status === "failed"
      ? (run.error ?? "That run didn't work out.")
      : running
        ? (run.statusDetail ?? "Getting started")
        : outcome(run);

  return (
    <div
      className={`${panelClass} ${broken ? "border-danger/30" : running ? "border-teal" : ""}`}
    >
      <div className="flex items-center gap-2.5">
        {running ? (
          <span
            aria-hidden
            className="animate-pulse-ring h-2.5 w-2.5 flex-none rounded-full bg-teal"
          />
        ) : null}
        <p className="font-medium">{running ? "Looking now" : origin(run)}</p>
      </div>
      <p
        role="status"
        aria-live="polite"
        className={`mt-1.5 text-sm leading-relaxed ${broken ? "text-danger" : "text-muted"}`}
      >
        {message}
      </p>
    </div>
  );
}
