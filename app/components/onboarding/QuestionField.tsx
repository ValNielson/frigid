"use client";

import {
  MAX_TEXT_LENGTH,
  NO_ALLERGIES,
  type Answer,
  type Question,
} from "@/convex/onboardingQuestions";
import { inputClass } from "@/app/lib/formClasses";

const chipBase =
  "cursor-pointer rounded-full border px-[18px] py-2.5 text-[15px] transition " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action";
const chipOn = "border-action bg-mint font-medium text-foreground";
const chipOff =
  "border-border-subtle bg-background text-muted hover:border-action/50 hover:text-foreground";

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
      <legend className="text-[21px] font-medium tracking-[-0.01em]">
        {question.prompt}
        {question.required === true ? (
          <span className="ml-1 text-action" aria-hidden>
            *
          </span>
        ) : null}
      </legend>
      {question.help !== undefined ? (
        <p className="mt-1.5 text-[15px] leading-relaxed text-muted">{question.help}</p>
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
          className={`${inputClass} mt-4 resize-y`}
        />
      ) : (
        <>
          <div className="mt-4 flex flex-wrap gap-[9px]">
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
              className={`${inputClass} mt-3`}
            />
          ) : null}
        </>
      )}
    </fieldset>
  );
}
