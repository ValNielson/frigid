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
import { QuestionField } from "./QuestionField";
import { SummaryReview } from "./SummaryReview";

/** Answers are mirrored here on every change so a refresh mid-quiz costs nothing. */
const DRAFT_KEY = "frigid.onboardingDraft";

const primaryButtonClass =
  "rounded-full bg-citrus px-6 py-3 text-base font-semibold text-white transition " +
  "hover:bg-citrus-strong focus-visible:outline-2 focus-visible:outline-offset-2 " +
  "focus-visible:outline-citrus disabled:cursor-not-allowed disabled:opacity-60";

const secondaryButtonClass =
  "rounded-full border border-border-subtle px-6 py-3 text-base font-medium text-muted " +
  "transition hover:border-frost hover:text-foreground disabled:opacity-60";

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
  const progress = Math.round(((step + 1) / totalSteps) * 100);

  return (
    <div className="w-full max-w-2xl">
      <div className="mb-8">
        <div className="flex items-baseline justify-between">
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-frost">
            {reviewing ? "Last look" : section}
          </p>
          <p className="text-xs text-muted">
            Step {Math.min(step + 1, totalSteps)} of {totalSteps}
          </p>
        </div>
        <div
          className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-surface-muted"
          role="progressbar"
          aria-valuenow={progress}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Onboarding progress"
        >
          <div
            className="h-full rounded-full bg-frost transition-all duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      <div className="rounded-3xl border border-border-subtle bg-surface p-8 shadow-sm sm:p-10">
        {reviewing ? (
          <SummaryReview answers={answers} />
        ) : (
          <div className="space-y-9">
            {questions.map((question) => (
              <QuestionField
                key={question.id}
                question={question}
                answer={answers[question.id]}
                onChange={(next) => setAnswer(question.id, next)}
              />
            ))}
          </div>
        )}

        {error !== null ? (
          <p role="status" aria-live="polite" className="mt-7 text-sm text-danger">
            {error}
          </p>
        ) : null}

        <div className="mt-9 flex flex-wrap items-center gap-3">
          {step > 0 ? (
            <button type="button" onClick={back} disabled={saving} className={secondaryButtonClass}>
              Back
            </button>
          ) : null}

          {reviewing ? (
            <button type="button" onClick={finish} disabled={saving} className={primaryButtonClass}>
              {saving ? "Saving…" : "Looks right — finish"}
            </button>
          ) : (
            <button type="button" onClick={next} className={primaryButtonClass}>
              Continue
            </button>
          )}
        </div>
      </div>

      {reviewing ? (
        <p className="mt-5 text-center text-sm text-muted">
          We&rsquo;ll email you a copy. You can change any of this later.
        </p>
      ) : null}
    </div>
  );
}
