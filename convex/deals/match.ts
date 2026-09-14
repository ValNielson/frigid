"use node";

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { api } from "../_generated/api";
import { excludeAllergens } from "./policy";

/**
 * Picks the coupons worth showing one person.
 *
 * Two stages, and the order is the point. Allergen exclusion is deterministic
 * and runs first, so nothing the model can say puts a declared allergen back.
 * Taste is a judgement, so it goes to the model — once, over every survivor at
 * once, rather than a call per coupon.
 */

const MATCH_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    picks: {
      type: "array",
      description: "The worthwhile coupons, best first",
      items: {
        type: "object",
        properties: {
          index: {
            type: "integer",
            description: "The candidate's number, exactly as given",
          },
          reason: {
            type: "string",
            description: "One short clause on why this suits them",
          },
        },
        required: ["index", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["picks"],
  additionalProperties: false,
});

const candidate = v.object({
  _id: v.id("coupons"),
  merchantId: v.id("merchants"),
  title: v.string(),
  details: v.optional(v.string()),
  code: v.optional(v.string()),
  discount: v.optional(v.string()),
  itemTerms: v.array(v.string()),
  tags: v.array(v.string()),
  expiresAt: v.optional(v.number()),
  sourceUrl: v.optional(v.string()),
});

export const selectForProfile = internalAction({
  args: {
    coupons: v.array(candidate),
    allergies: v.array(v.string()),
    promptContext: v.string(),
    limit: v.optional(v.number()),
  },
  returns: v.object({
    picks: v.array(
      v.object({
        coupon: candidate,
        reason: v.string(),
      }),
    ),
    excludedForAllergies: v.number(),
  }),
  handler: async (ctx, args) => {
    const safe = excludeAllergens(args.coupons, args.allergies);
    const excludedForAllergies = args.coupons.length - safe.length;

    if (safe.length === 0) return { picks: [], excludedForAllergies };

    const limit = args.limit ?? 12;

    const lines = safe.map((coupon, index) => {
      const parts = [coupon.title];
      if (coupon.discount !== undefined) parts.push(`(${coupon.discount})`);
      if (coupon.details !== undefined) parts.push(`- ${coupon.details}`);
      return `${index}. ${parts.join(" ")}`;
    });

    const raw = await ctx.runAction(api.openai.structured, {
      prompt: `Cook's profile: ${args.promptContext}\n\nCandidates:\n${lines.join("\n")}`,
      schemaName: "coupon_picks",
      schemaJson: MATCH_SCHEMA,
      instructions:
        `Choose up to ${limit} coupons this cook would actually use, best ` +
        "first. Weigh what they like to cook and eat, the cuisines they " +
        "named, their budget, and their household size. Skip anything they " +
        "said they dislike or that does not fit how they eat. Returning " +
        "fewer is better than padding the list. Reference candidates by the " +
        "number shown and never invent one.",
    });

    let parsed: { picks?: { index: number; reason: string }[] };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { picks: [], excludedForAllergies };
    }

    const seen = new Set<number>();
    const picks = [];

    for (const pick of parsed.picks ?? []) {
      // The model addresses candidates by position, so an out-of-range or
      // repeated index is dropped rather than trusted: the alternative is a
      // digest built around a coupon that was never on the list.
      if (!Number.isInteger(pick.index)) continue;
      if (pick.index < 0 || pick.index >= safe.length) continue;
      if (seen.has(pick.index)) continue;
      seen.add(pick.index);
      picks.push({ coupon: safe[pick.index], reason: pick.reason });
      if (picks.length >= limit) break;
    }

    return { picks, excludedForAllergies };
  },
});
