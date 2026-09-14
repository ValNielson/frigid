import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { v } from "convex/values";

/**
 * One daily job rather than a schedule per cadence.
 *
 * Every emailFrequency option is served by asking, per user, whether enough
 * time has passed since their last digest. "Only when I ask" is not a cadence
 * in that table at all, so the opt-out is enforced by never selecting those
 * rows — see usersDueForDigest.
 */
export const runDueDigests = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    const due = await ctx.runQuery(internal.deals.data.usersDueForDigest, {
      now,
    });

    for (const userId of due) {
      // Scheduled individually so one person's failed run cannot stop everyone
      // else's mail, and so a long list does not run as one oversized action.
      await ctx.scheduler.runAfter(0, internal.deals.run.execute, {
        userId,
        trigger: "cron",
      });
    }

    return null;
  },
});

const crons = cronJobs();

// Daily rather than hourly: the most frequent option anyone can choose is once
// a day, so checking more often would only re-ask a question already answered.
crons.daily(
  "deal digests",
  { hourUTC: 13, minuteUTC: 0 },
  internal.crons.runDueDigests,
);

export default crons;
