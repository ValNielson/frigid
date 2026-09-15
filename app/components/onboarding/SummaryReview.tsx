"use client";

import type { Answers } from "@/convex/onboardingQuestions";
import { buildOpening, buildSections, realAllergies } from "@/convex/onboardingSummary";
import { AllergyNotice } from "@/app/components/ui";

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
      <h2 className="text-[28px] font-semibold tracking-[-0.02em]">
        Here&rsquo;s what we heard
      </h2>
      {opening.length > 0 ? (
        <p className="mt-2.5 text-[17px] leading-relaxed text-muted">{opening}</p>
      ) : null}

      {allergies.length > 0 ? (
        <div className="mt-5">
          <AllergyNotice title={`Allergies on file: ${allergies.join(", ")}.`}>
            We treat these as a hard rule, never a preference.
          </AllergyNotice>
        </div>
      ) : null}

      <div className="mt-8 space-y-6">
        {sections.map((section) => (
          <section key={section.title}>
            <h3 className="slab">{section.title}</h3>
            <dl className="mt-3 border-t border-border-subtle">
              {section.lines.map((line) => (
                <div
                  key={line.label}
                  className="grid gap-1 border-b border-border-subtle py-3 sm:grid-cols-[200px_1fr] sm:gap-5"
                >
                  <dt className="text-[15px] text-muted">{line.label}</dt>
                  <dd className="text-[15px]">{line.value}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </div>
  );
}
