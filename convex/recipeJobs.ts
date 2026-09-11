/**
 * The recipe job record: starting one, reading it, and the internal writes the
 * pipeline makes as it moves through its steps.
 *
 * The job row is the UI model. The screen subscribes to the latest row and
 * every step patches it, so progress is reactive without a polling loop or a
 * workflow engine.
 */

import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { userForToken } from "./sessions";
import type { Doc } from "./_generated/dataModel";
import {
  DAILY_CREDIT_BUDGET,
  MAX_JOBS_PER_USER_PER_DAY,
  MAX_PROMPT_LENGTH,
  MIN_PROMPT_LENGTH,
  STALL_AFTER_MS,
} from "./recipePolicy";

const DAY_MS = 24 * 60 * 60 * 1000;

const jobStatus = v.union(
  v.literal("queued"),
  v.literal("searching"),
  v.literal("reading"),
  v.literal("shopping"),
  v.literal("emailing"),
  v.literal("done"),
  v.literal("failed"),
);

const ingredient = v.object({
  raw: v.string(),
  item: v.string(),
  quantity: v.optional(v.string()),
});

const jobRecipe = v.object({
  url: v.string(),
  name: v.string(),
  image: v.optional(v.string()),
  totalTimeMinutes: v.optional(v.number()),
  servings: v.optional(v.string()),
  source: v.union(v.literal("jsonld"), v.literal("markdown"), v.literal("llm")),
  ingredients: v.array(ingredient),
});

const shoppingEntry = v.object({
  item: v.string(),
  usedIn: v.array(v.string()),
  department: v.string(),
  stores: v.array(
    v.object({
      storeSlug: v.string(),
      storeLabel: v.string(),
      searchUrl: v.optional(v.string()),
      productTitle: v.optional(v.string()),
      productUrl: v.optional(v.string()),
    }),
  ),
});

const candidate = v.object({
  url: v.string(),
  title: v.string(),
  description: v.optional(v.string()),
});

/** Statuses where the pipeline is still expected to do something. */
const ACTIVE: readonly string[] = [
  "queued",
  "searching",
  "reading",
  "shopping",
  "emailing",
];

// ------------------------------------------------------------ public surface

/**
 * Starts a job, or explains why it will not.
 *
 * Returns an error string rather than throwing, matching preferences.save —
 * every rejection here is something the user can act on, not a bug.
 */
export const start = mutation({
  args: { sessionToken: v.string(), prompt: v.string() },
  returns: v.object({
    ok: v.boolean(),
    jobId: v.optional(v.id("recipeJobs")),
    error: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const user = await userForToken(ctx, args.sessionToken);
    if (user === null) return { ok: false, error: "Please verify your email again." };

    const prompt = args.prompt.trim().slice(0, MAX_PROMPT_LENGTH);
    if (prompt.length < MIN_PROMPT_LENGTH) {
      return { ok: false, error: "Tell us a little more about what you want to cook." };
    }

    const preferences = await ctx.db
      .query("preferences")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .unique();
    if (preferences === null) {
      return { ok: false, error: "Finish your taste profile first so we know what to look for." };
    }

    // One at a time. Searches are slow and cost credits, and a user who clicks
    // twice wants one answer, not two.
    for (const status of ACTIVE) {
      const inFlight = await ctx.db
        .query("recipeJobs")
        .withIndex("by_user_status", (q) =>
          q.eq("userId", user._id).eq("status", status as "queued"),
        )
        .first();
      if (inFlight !== null) {
        return { ok: false, error: "We're still working on your last search. One moment." };
      }
    }

    const now = Date.now();
    const since = now - DAY_MS;

    const recent = await ctx.db
      .query("recipeJobs")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(MAX_JOBS_PER_USER_PER_DAY);
    if (
      recent.length >= MAX_JOBS_PER_USER_PER_DAY &&
      recent.every((job) => job.createdAt > since)
    ) {
      return { ok: false, error: "That's all the searches for today. Try again tomorrow." };
    }

    // Global brake. The Firecrawl allowance is monthly, so one runaway day
    // must not be able to take the rest of the month with it.
    const today = await ctx.db
      .query("recipeJobs")
      .withIndex("by_created", (q) => q.gt("createdAt", since))
      .collect();
    const spentToday = today.reduce((total, job) => total + job.creditsUsed, 0);
    if (spentToday >= DAILY_CREDIT_BUDGET) {
      return { ok: false, error: "We've hit today's search budget. Try again tomorrow." };
    }

    const jobId = await ctx.db.insert("recipeJobs", {
      userId: user._id,
      prompt,
      searchQuery: "",
      status: "queued",
      candidates: [],
      recipes: [],
      shopping: [],
      skipped: [],
      creditsUsed: 0,
      llmCallsUsed: 0,
      createdAt: now,
      updatedAt: now,
    });

    // Scheduled rather than awaited: the mutation returns immediately and the
    // screen picks the job up reactively.
    await ctx.scheduler.runAfter(0, internal.recipeRun.search, { jobId });

    return { ok: true, jobId };
  },
});

const jobView = v.object({
  jobId: v.id("recipeJobs"),
  prompt: v.string(),
  status: jobStatus,
  statusDetail: v.optional(v.string()),
  /** Derived, not stored: a step that died leaves the row untouched. */
  stalled: v.boolean(),
  recipes: v.array(jobRecipe),
  shopping: v.array(shoppingEntry),
  skipped: v.array(v.object({ url: v.string(), reason: v.string() })),
  creditsUsed: v.number(),
  error: v.optional(v.string()),
  emailed: v.boolean(),
  createdAt: v.number(),
});

/**
 * Job row to the shape the screen renders.
 *
 * Takes the document type directly rather than a hand-written structural type:
 * casting here would flow `never` into the query's inferred return type and
 * strip every field off the client.
 */
function toView(job: Doc<"recipeJobs">) {
  return {
    jobId: job._id,
    prompt: job.prompt,
    status: job.status,
    ...(job.statusDetail !== undefined ? { statusDetail: job.statusDetail } : {}),
    stalled:
      ACTIVE.includes(job.status) && Date.now() - job.updatedAt > STALL_AFTER_MS,
    recipes: job.recipes,
    shopping: job.shopping,
    skipped: job.skipped,
    creditsUsed: job.creditsUsed,
    ...(job.error !== undefined ? { error: job.error } : {}),
    emailed: job.emailedAt !== undefined,
    createdAt: job.createdAt,
  };
}

/** Backs the home screen. One reactive read drives the whole card. */
export const latest = query({
  args: { sessionToken: v.optional(v.string()) },
  returns: v.union(v.null(), jobView),
  handler: async (ctx, args) => {
    const user = await userForToken(ctx, args.sessionToken);
    if (user === null) return null;

    const job = await ctx.db
      .query("recipeJobs")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .order("desc")
      .first();
    return job === null ? null : toView(job);
  },
});

// ---------------------------------------------------------- internal writes

/** Job plus the preference fields the pipeline needs, in one read. */
export const forRun = internalQuery({
  args: { jobId: v.id("recipeJobs") },
  returns: v.union(
    v.null(),
    v.object({
      prompt: v.string(),
      searchQuery: v.string(),
      status: jobStatus,
      candidates: v.array(candidate),
      recipes: v.array(jobRecipe),
      shopping: v.array(shoppingEntry),
      llmCallsUsed: v.number(),
      answers: v.record(
        v.string(),
        v.object({ choices: v.array(v.string()), other: v.optional(v.string()) }),
      ),
      email: v.string(),
      subscribed: v.boolean(),
      unsubscribeToken: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (job === null) return null;

    const user = await ctx.db.get(job.userId);
    if (user === null) return null;

    const preferences = await ctx.db
      .query("preferences")
      .withIndex("by_user", (q) => q.eq("userId", job.userId))
      .unique();
    if (preferences === null) return null;

    return {
      prompt: job.prompt,
      searchQuery: job.searchQuery,
      status: job.status,
      candidates: job.candidates,
      recipes: job.recipes,
      shopping: job.shopping,
      llmCallsUsed: job.llmCallsUsed,
      answers: preferences.answers,
      email: user.email,
      subscribed: user.subscribed,
      unsubscribeToken: user.unsubscribeToken,
    };
  },
});

export const markStatus = internalMutation({
  args: {
    jobId: v.id("recipeJobs"),
    status: v.optional(jobStatus),
    statusDetail: v.optional(v.string()),
    creditsDelta: v.optional(v.number()),
    llmDelta: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (job === null) return null;
    await ctx.db.patch(args.jobId, {
      ...(args.status !== undefined ? { status: args.status } : {}),
      ...(args.statusDetail !== undefined ? { statusDetail: args.statusDetail } : {}),
      creditsUsed: job.creditsUsed + (args.creditsDelta ?? 0),
      llmCallsUsed: job.llmCallsUsed + (args.llmDelta ?? 0),
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const setCandidates = internalMutation({
  args: {
    jobId: v.id("recipeJobs"),
    searchQuery: v.string(),
    candidates: v.array(candidate),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.jobId, {
      searchQuery: args.searchQuery,
      candidates: args.candidates,
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const addRecipe = internalMutation({
  args: { jobId: v.id("recipeJobs"), recipe: jobRecipe },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (job === null) return null;
    await ctx.db.patch(args.jobId, {
      recipes: [...job.recipes, args.recipe],
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const addSkipped = internalMutation({
  args: { jobId: v.id("recipeJobs"), url: v.string(), reason: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (job === null) return null;
    await ctx.db.patch(args.jobId, {
      skipped: [...job.skipped, { url: args.url, reason: args.reason }],
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const setShopping = internalMutation({
  args: { jobId: v.id("recipeJobs"), shopping: v.array(shoppingEntry) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.jobId, {
      shopping: args.shopping,
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const markDone = internalMutation({
  args: { jobId: v.id("recipeJobs"), emailed: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    await ctx.db.patch(args.jobId, {
      status: "done",
      statusDetail: undefined,
      finishedAt: now,
      updatedAt: now,
      ...(args.emailed ? { emailedAt: now } : {}),
    });
    return null;
  },
});

/**
 * Terminal failure. Convex does not retry a scheduled action, so every step
 * calls this from its catch — without it a thrown error would leave the job
 * sitting in "reading" forever and the screen spinning.
 */
export const markFailed = internalMutation({
  args: { jobId: v.id("recipeJobs"), error: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    await ctx.db.patch(args.jobId, {
      status: "failed",
      statusDetail: undefined,
      error: args.error.slice(0, 300),
      finishedAt: now,
      updatedAt: now,
    });
    return null;
  },
});
