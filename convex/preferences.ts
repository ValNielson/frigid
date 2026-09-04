import { v } from "convex/values";
import { internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { userForToken } from "./sessions";
import {
  MAX_TEXT_LENGTH,
  NO_ALLERGIES,
  QUESTIONS,
  SCHEMA_VERSION,
  isAnswered,
  questionById,
  type Answers,
} from "./onboardingQuestions";
import { buildPromptContext, renderSummaryText } from "./onboardingSummary";

const answersValidator = v.record(
  v.string(),
  v.object({ choices: v.array(v.string()), other: v.optional(v.string()) }),
);

/**
 * Rejects anything the wizard could not legitimately have produced.
 *
 * The client is not trusted to have validated: a submitted choice must be one
 * of the options we actually offered, so free text can only ever arrive through
 * the `other` field where it is length-capped. Returns an error string, or null
 * when the answers are good.
 */
function validate(answers: Answers): string | null {
  for (const [id, answer] of Object.entries(answers)) {
    const question = questionById(id);
    if (question === undefined) return `Unknown question: ${id}`;

    if (question.kind === "text") {
      if (answer.choices.length > 0) return `${id} does not take choices`;
    } else {
      const allowed = new Set(question.options ?? []);
      for (const choice of answer.choices) {
        if (!allowed.has(choice)) return `Unexpected option for ${id}`;
      }
      if (question.kind === "single" && answer.choices.length > 1) {
        return `${id} takes a single answer`;
      }
      if (answer.other !== undefined && question.allowOther !== true) {
        return `${id} does not accept free text`;
      }
    }

    if ((answer.other ?? "").length > MAX_TEXT_LENGTH) {
      return `Your answer to "${question.prompt}" is too long`;
    }
  }

  for (const question of QUESTIONS) {
    if (question.required !== true) continue;
    if (!isAnswered(question, answers[question.id])) {
      return `Please answer: ${question.prompt}`;
    }
  }

  // The one substantive rule. An empty allergies answer is caught above, but
  // "no allergies" plus a named allergen is contradictory and we would not know
  // which to believe — better to ask than to guess wrong about an allergen.
  const allergyChoices = answers["allergies"]?.choices ?? [];
  if (allergyChoices.includes(NO_ALLERGIES) && allergyChoices.length > 1) {
    return "Either pick your allergies, or pick \"No food allergies\" on its own";
  }

  return null;
}

/**
 * Saves the questionnaire and marks the user onboarded.
 *
 * Idempotent: running it again updates the existing row and leaves the original
 * onboardedAt alone, so re-taking the quiz does not look like a second signup.
 */
export const save = mutation({
  args: { sessionToken: v.string(), answers: answersValidator },
  returns: v.object({
    ok: v.boolean(),
    error: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const user = await userForToken(ctx, args.sessionToken);
    if (user === null) return { ok: false, error: "Please verify your email again." };

    const problem = validate(args.answers);
    if (problem !== null) return { ok: false, error: problem };

    const now = Date.now();
    const summaryText = renderSummaryText(args.answers);
    const promptContext = buildPromptContext(args.answers);

    const existing = await ctx.db
      .query("preferences")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .unique();

    if (existing === null) {
      await ctx.db.insert("preferences", {
        userId: user._id,
        schemaVersion: SCHEMA_VERSION,
        answers: args.answers,
        summaryText,
        promptContext,
        completedAt: now,
        updatedAt: now,
      });
    } else {
      await ctx.db.patch(existing._id, {
        schemaVersion: SCHEMA_VERSION,
        answers: args.answers,
        summaryText,
        promptContext,
        updatedAt: now,
      });
    }

    await ctx.db.patch(user._id, {
      onboardedAt: user.onboardedAt ?? now,
      emailFrequency: args.answers["emailFrequency"]?.choices[0],
    });

    // Scheduled rather than awaited: a slow or failing mail provider must not
    // block the redirect, and the answers are already safely stored.
    await ctx.scheduler.runAfter(0, internal.onboardingEmail.sendSummary, {
      userId: user._id,
    });

    return { ok: true };
  },
});

/** Backs the home screen and a future settings page. */
export const getMine = query({
  args: { sessionToken: v.optional(v.string()) },
  returns: v.union(
    v.null(),
    v.object({
      answers: answersValidator,
      summaryText: v.string(),
      completedAt: v.number(),
      updatedAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const user = await userForToken(ctx, args.sessionToken);
    if (user === null) return null;

    const row = await ctx.db
      .query("preferences")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .unique();
    if (row === null) return null;

    return {
      answers: row.answers,
      summaryText: row.summaryText,
      completedAt: row.completedAt,
      updatedAt: row.updatedAt,
    };
  },
});

/**
 * What recipe generation will read. Returns the pre-built line rather than the
 * raw answers, so callers paste a short string into a prompt instead of paying
 * to re-describe the user every time.
 */
export const getPromptContext = internalQuery({
  args: { userId: v.id("users") },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("preferences")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
    return row?.promptContext ?? null;
  },
});

/** Everything the summary email needs, in one read. */
export const forSummaryEmail = internalQuery({
  args: { userId: v.id("users") },
  returns: v.union(
    v.null(),
    v.object({
      email: v.string(),
      subscribed: v.boolean(),
      unsubscribeToken: v.string(),
      answers: answersValidator,
    }),
  ),
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (user === null) return null;
    const row = await ctx.db
      .query("preferences")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
    if (row === null) return null;
    return {
      email: user.email,
      subscribed: user.subscribed,
      unsubscribeToken: user.unsubscribeToken,
      answers: row.answers,
    };
  },
});
