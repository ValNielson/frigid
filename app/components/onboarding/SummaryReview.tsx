"use client";

import type { Answers } from "@/convex/onboardingQuestions";
import { buildOpening, buildSections, realAllergies } from "@/convex/onboardingSummary";

/**
 * The last step: what we understood, before it is saved.
 *
 * Rendered from the same buildOpening/buildSections the email uses, so the
 * screen and the email cannot describe the same answers differently. No round
 * trip and no model call — the report is a template, so previewing it is free.
 */
export function SummaryReview({ answers }: { answers: Answers }) {
  const opening = buildOpening(answers);
  const sections = buildSections(answers);
  const allergies = realAllergies(answers);

  return (
    <div>
      <h2 className="text-2xl font-semibold tracking-tight">Here&rsquo;s what we heard</h2>
      {opening.length > 0 ? (
        <p className="mt-3 leading-relaxed text-muted">{opening}</p>
      ) : null}

      {allergies.length > 0 ? (
        <p className="mt-5 rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm leading-relaxed text-danger">
          <span className="font-semibold">Allergies on file:</span>{" "}
          {allergies.join(", ")}. We treat these as a hard rule, never a preference.
        </p>
      ) : null}

      <div className="mt-8 space-y-7">
        {sections.map((section) => (
          <section key={section.title}>
            <h3 className="text-xs font-medium uppercase tracking-[0.16em] text-frost">
              {section.title}
            </h3>
            <dl className="mt-3 divide-y divide-border-subtle border-t border-border-subtle">
              {section.lines.map((line) => (
                <div key={line.label} className="grid gap-1 py-3 sm:grid-cols-5 sm:gap-4">
                  <dt className="text-sm text-muted sm:col-span-2">{line.label}</dt>
                  <dd className="text-sm sm:col-span-3">{line.value}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </div>
  );
}
