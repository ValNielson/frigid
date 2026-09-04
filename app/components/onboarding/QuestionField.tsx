"use client";

import {
  MAX_TEXT_LENGTH,
  NO_ALLERGIES,
  type Answer,
  type Question,
} from "@/convex/onboardingQuestions";

const chipBase =
  "rounded-full border px-4 py-2 text-sm transition cursor-pointer " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-frost";
const chipOn = "border-frost bg-frost-soft font-medium text-foreground";
const chipOff = "border-border-subtle bg-surface-muted text-muted hover:border-frost/50";

const textClass =
  "w-full rounded-xl border border-border-subtle bg-surface-muted px-4 py-3 text-base " +
  "text-foreground outline-none transition placeholder:text-muted/70 " +
  "focus:border-frost focus:ring-2 focus:ring-frost/30";

const EMPTY: Answer = { choices: [] };

export function QuestionField({
  question,
  answer,
  onChange,
}: {
  question: Question;
  answer: Answer | undefined;
  onChange: (next: Answer) => void;
}) {
  const current = answer ?? EMPTY;

  function toggle(option: string) {
    if (question.kind === "single") {
      // Tapping the selected option again clears it, so an optional single
      // question can be un-answered without a reset button.
      onChange({
        ...current,
        choices: current.choices[0] === option ? [] : [option],
      });
      return;
    }

    const on = current.choices.includes(option);
    let choices = on
      ? current.choices.filter((c) => c !== option)
      : [...current.choices, option];

    // "No food allergies" is mutually exclusive with naming an allergen. The
    // server rejects the contradiction too; this just stops the user from
    // building one by accident.
    if (question.id === "allergies" && !on) {
      choices =
        option === NO_ALLERGIES
          ? [NO_ALLERGIES]
          : choices.filter((c) => c !== NO_ALLERGIES);
    }

    onChange({ ...current, choices });
  }

  const otherValue = current.other ?? "";

  return (
    <fieldset className="border-0 p-0">
      <legend className="text-lg font-medium tracking-tight">
        {question.prompt}
        {question.required === true ? (
          <span className="ml-1 text-danger" aria-hidden>
            *
          </span>
        ) : null}
      </legend>
      {question.help !== undefined ? (
        <p className="mt-2 text-sm leading-relaxed text-muted">{question.help}</p>
      ) : null}

      {question.kind === "text" ? (
        <textarea
          value={otherValue}
          onChange={(e) =>
            onChange({ choices: [], other: e.target.value.slice(0, MAX_TEXT_LENGTH) })
          }
          rows={3}
          maxLength={MAX_TEXT_LENGTH}
          placeholder={question.id === "location" ? "Grand Rapids, MI" : "Anything at all"}
          className={`${textClass} mt-4 resize-y`}
        />
      ) : (
        <>
          <div className="mt-4 flex flex-wrap gap-2">
            {(question.options ?? []).map((option) => {
              const on = current.choices.includes(option);
              return (
                <button
                  key={option}
                  type="button"
                  role={question.kind === "single" ? "radio" : "checkbox"}
                  aria-checked={on}
                  onClick={() => toggle(option)}
                  className={`${chipBase} ${on ? chipOn : chipOff}`}
                >
                  {option}
                </button>
              );
            })}
          </div>

          {question.allowOther === true ? (
            <input
              type="text"
              value={otherValue}
              onChange={(e) =>
                onChange({ ...current, other: e.target.value.slice(0, MAX_TEXT_LENGTH) })
              }
              maxLength={MAX_TEXT_LENGTH}
              placeholder="Something else? Type it here"
              aria-label={`${question.prompt} — something else`}
              className={`${textClass} mt-3`}
            />
          ) : null}
        </>
      )}
    </fieldset>
  );
}
