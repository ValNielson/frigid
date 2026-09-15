"use client";

import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import { useSessionToken } from "@/app/lib/session";
import { panelClass } from "@/app/lib/formClasses";

type Run = NonNullable<FunctionReturnType<typeof api.deals.latestRun>>;

/**
 * What a run's outcome means in one line, so the full card and the compact one
 * cannot drift apart on the wording. Zero matches is a real answer, not a
 * failure: the profile and the week's coupons genuinely did not overlap.
 */
function outcome(run: Run): string {
  if (run.status === "skipped") {
    return "Paused for today — we had spent this day's budget for reading store pages.";
  }
  if (run.couponsMatched === 0) {
    return "Nothing worth sending this time. The stores near you are not discounting anything that suits your profile.";
  }
  const plural = run.couponsMatched === 1 ? "deal" : "deals";
  return `${run.couponsMatched} ${plural} matched to your profile, sent to your email.`;
}

/** Whether the run happened because the user asked, or on its own schedule. */
function origin(run: Run): string {
  if (run.trigger === "cron") return "Your scheduled look for deals";
  if (run.kind === "ingredients") return "Deals for your shopping list";
  return "Your last look for deals";
}

/**
 * The latest run, for anything that needs to know one is in flight.
 *
 * Shared with the composer so it can stop a second ask going out while the
 * first is still working — the server refuses it anyway (MANUAL_RUN_COOLDOWN_MS),
 * and a button that spends a click to earn an error is worse than one that waits.
 */
export function useLatestRun(): Run | null | undefined {
  const session = useSessionToken();
  const args =
    session.status === "ready" ? { sessionToken: session.token ?? undefined } : "skip";
  return useQuery(api.deals.latestRun, args);
}

/** True while a run is genuinely working, as opposed to finished or wedged. */
export function isRunning(run: Run | null | undefined): boolean {
  return run?.status === "running" && !run.stalled;
}

export function DealsRunCard({ compact = false }: { compact?: boolean }) {
  const run = useLatestRun();

  if (run === undefined || run === null) {
    if (!compact) return null;
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

  if (compact) {
    return (
      <div
        className={`${panelClass} ${broken ? "border-danger/30" : running ? "border-teal" : ""}`}
      >
        <div className="flex items-center gap-2.5">
          {running ? (
            <span aria-hidden className="animate-pulse-ring h-2.5 w-2.5 flex-none rounded-full bg-teal" />
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

  if (broken) {
    return (
      <div className="rounded-[20px] border border-danger/30 bg-surface px-6 py-5">
        <p role="status" aria-live="polite" className="text-[15px] text-danger">
          {message}
        </p>
        <p className="mt-3 text-sm text-muted">
          Ask again whenever — store pages we have already read are cached, so
          another run costs nothing extra.
        </p>
      </div>
    );
  }

  if (running) {
    return (
      <div className="flex items-start gap-5 rounded-[20px] border border-teal bg-surface px-[22px] py-5">
        <div aria-hidden className="animate-pulse-ring h-11 w-11 flex-none rounded-full bg-teal" />
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <span className="text-lg font-medium">Looking for deals near you</span>
          {/* One indeterminate bar rather than the recipe card's segmented one:
              a run's length is however many stores its city turns out to have,
              so there is no honest fraction to draw. */}
          <div aria-hidden className="animate-shimmer h-[7px] rounded-full bg-track" />
          <p role="status" aria-live="polite" className="text-sm text-muted">
            {message}
          </p>
          <p className="text-sm text-muted">
            This takes a few minutes. We&rsquo;ll email you when it&rsquo;s done —
            you can close this.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-[20px] border border-border-subtle bg-surface px-6 py-5">
      <p className="slab">{origin(run)}</p>
      <p role="status" aria-live="polite" className="mt-2 text-[15px] leading-relaxed">
        {message}
      </p>
    </div>
  );
}
