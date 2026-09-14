/**
 * The profile artifacts built once at onboarding and read on every later run.
 *
 * promptContext is pasted into prompts instead of re-deriving a profile from
 * twenty answers, so what it says about allergies is what a model is told.
 */

import { test } from "vitest";
import assert from "node:assert/strict";

import {
  buildOpening,
  buildPromptContext,
  realAllergies,
} from "../convex/onboardingSummary.ts";
import { NO_ALLERGIES } from "../convex/onboardingQuestions.ts";

const PROFILE = {
  householdSize: { choices: ["Two people"] },
  location: { choices: [], other: "Grand Rapids, MI" },
  cuisinesLove: { choices: ["Thai", "Italian"] },
  allergies: { choices: ["Peanuts"] },
  stores: { choices: ["Meijer"] },
};

test("the no-allergies opt-out is an answer, not an allergen", () => {
  assert.deepEqual(realAllergies({ allergies: { choices: [NO_ALLERGIES] } }), []);
  assert.deepEqual(
    realAllergies({ allergies: { choices: ["Peanuts", NO_ALLERGIES] } }),
    ["Peanuts"],
  );
});

test("allergies are stated as a hard rule and kept apart from taste", () => {
  const context = buildPromptContext(PROFILE);
  assert.match(context, /ALLERGIES \(hard rule, never suggest\): Peanuts\./);
  // Dislikes and allergies must not read the same to whatever consumes this.
  assert.ok(!context.includes("Loves: Peanuts"));
});

test("allergies are always stated, so 'none' is distinguishable from 'never asked'", () => {
  assert.equal(buildPromptContext({}), "ALLERGIES: none reported.");
  assert.equal(
    buildPromptContext({ allergies: { choices: [NO_ALLERGIES] } }),
    "ALLERGIES: none reported.",
  );
});

test("the context carries the answers a search actually spends money on", () => {
  const context = buildPromptContext(PROFILE);
  for (const expected of ["Grand Rapids, MI", "Meijer", "Two people", "Thai, Italian"]) {
    assert.ok(context.includes(expected), `expected ${expected} in ${context}`);
  }
});

test("the opening promises the allergy exclusion in plain words", () => {
  assert.match(
    buildOpening(PROFILE),
    /keep Peanuts out of everything we send you, without exception/,
  );
});

test("the opening degrades to nothing rather than half a sentence", () => {
  assert.equal(buildOpening({}), "");
});
