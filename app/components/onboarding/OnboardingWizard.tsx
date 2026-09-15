"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  SECTIONS,
  isAnswered,
  questionsForSection,
  type Answer,
  type Answers,
} from "@/convex/onboardingQuestions";
import { useSessionToken } from "@/app/lib/session";
import { cardClass, primaryButtonClass, secondaryButtonClass } from "@/app/lib/formClasses";
import { QuestionField } from "./QuestionField";
import { SummaryReview } from "./SummaryReview";

/** Answers are mirrored here on every change so a refresh mid-quiz costs nothing. */
const DRAFT_KEY = "frigid.onboardingDraft";

function readDraft(): Answers {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY);
    return raw === null ? {} : (JSON.parse(raw) as Answers);
  } catch {
    return {};
  }
}

export function OnboardingWizard({ initialAnswers }: { initialAnswers?: Answers }) {
  const router = useRouter();
  const session = useSessionToken();
  const save = useMutation(api.preferences.save);

  // Index into SECTIONS; the step one past the end is the review.
  const [step, setStep] = useState(0);
  // Read straight from localStorage in the initializer rather than syncing it in
  // an effect. Safe because AuthGate renders a skeleton until the session is
  // known, so this component's first render is always client-side — there is no
  // server render for it to disagree with. Saved answers beat a stale draft, so
  // "update my answers" starts from what is actually on file.
  const [answers, setAnswers] = useState<Answers>(
    () => initialAnswers ?? readDraft(),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    try {
      window.localStorage.setItem(DRAFT_KEY, JSON.stringify(answers));
    } catch {
      // A refresh will just start over; not worth interrupting the user.
    }
  }, [answers]);

  const reviewing = step >= SECTIONS.length;
  const section = SECTIONS[Math.min(step, SECTIONS.length - 1)];
  const questions = useMemo(() => questionsForSection(section), [section]);

  const unanswered = questions.filter(
    (q) => q.required === true && !isAnswered(q, answers[q.id]),
  );

  function setAnswer(id: string, next: Answer) {
    setAnswers((prev) => ({ ...prev, [id]: next }));
    setError(null);
  }

  function next() {
    if (unanswered.length > 0) {
      setError(`Please answer: ${unanswered[0].prompt}`);
      return;
    }
    setError(null);
    setStep((s) => s + 1);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function back() {
    setError(null);
    setStep((s) => Math.max(0, s - 1));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function finish() {
    if (session.status !== "ready" || session.token === null) {
      setError("Your session expired. Please verify your email again.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await save({ sessionToken: session.token, answers });
      if (!result.ok) {
        setError(result.error ?? "We couldn't save that. Try again.");
        return;
      }
      try {
        window.localStorage.removeItem(DRAFT_KEY);
      } catch {
        // Ignore.
      }
      router.replace("/home");
    } catch {
      setError("Something went wrong saving that. Try again in a moment.");
    } finally {
      setSaving(false);
    }
  }

  const totalSteps = SECTIONS.length + 1;
  const current = Math.min(step + 1, totalSteps);

  return (
    <div className="w-full">
      {reviewing ? null : (
        <header className="mb-8 flex flex-col gap-3 text-center">
          <h1 className="text-3xl font-semibold tracking-[-0.025em] sm:text-[38px]">
            Tell us how you cook
          </h1>
          <p className="mx-auto max-w-[480px] text-[17px] leading-relaxed text-muted">
            A few questions so every recipe we send actually fits your kitchen,
            your week, and your table. Skip anything that doesn&rsquo;t apply.
          </p>
        </header>
      )}

      <div
        className="flex items-center gap-3.5"
        role="progressbar"
        aria-valuenow={current}
        aria-valuemin={1}
        aria-valuemax={totalSteps}
        aria-label="Onboarding progress"
      >
        <div className="flex flex-1 gap-[5px]">
          {Array.from({ length: totalSteps }, (_, i) => (
            <div
              key={i}
              className={`h-1.5 flex-1 rounded-full transition-colors duration-300 ${
                i < current ? "bg-action" : "bg-plum/12"
              }`}
            />
          ))}
        </div>
        <span className="font-mono text-xs text-subtle uppercase">
          {reviewing ? "Last look" : `Step ${current} / ${totalSteps}`}
        </span>
      </div>

      <div className={`${cardClass} mt-5 sm:p-9`}>
        {reviewing ? (
          <SummaryReview answers={answers} />
        ) : (
          <>
            <span className="slab">{section}</span>
            <div className="mt-6 space-y-8">
              {questions.map((question) => (
                <QuestionField
                  key={question.id}
                  question={question}
                  answer={answers[question.id]}
                  onChange={(next) => setAnswer(question.id, next)}
                />
              ))}
            </div>
          </>
        )}

        {error !== null ? (
          <p role="status" aria-live="polite" className="mt-7 text-sm text-danger">
            {error}
          </p>
        ) : null}

        <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
          {reviewing ? null : (
            <span className="text-sm text-subtle">Your answers save as you go.</span>
          )}
          <div className="flex flex-wrap items-center gap-3">
            {step > 0 ? (
              <button
                type="button"
                onClick={back}
                disabled={saving}
                className={secondaryButtonClass}
              >
                Back
              </button>
            ) : null}

            {reviewing ? (
              <button
                type="button"
                onClick={finish}
                disabled={saving}
                className={primaryButtonClass}
              >
                {saving ? "Saving…" : "Looks right — finish"}
              </button>
            ) : (
              <button type="button" onClick={next} className={primaryButtonClass}>
                Continue
              </button>
            )}
          </div>
        </div>
      </div>

      {reviewing ? (
        <p className="mt-4 text-center text-sm text-subtle">
          We&rsquo;ll email you a copy. You can change any of this later.
        </p>
      ) : null}
    </div>
  );
}
