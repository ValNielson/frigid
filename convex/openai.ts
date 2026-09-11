"use node";

import OpenAI from "openai";
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { requireEnv } from "./env";

export const complete = internalAction({
  args: {
    prompt: v.string(),
    instructions: v.optional(v.string()),
    model: v.optional(v.string()),
    maxOutputTokens: v.optional(v.number()),
  },
  returns: v.string(),
  handler: async (_ctx, args) => {
    const openai = new OpenAI({ apiKey: requireEnv("OPENAI_API_KEY") });
    const response = await openai.responses.create({
      model: args.model ?? "gpt-5.5",
      instructions: args.instructions,
      input: args.prompt,
      ...(args.maxOutputTokens !== undefined
        ? { max_output_tokens: args.maxOutputTokens }
        : {}),
    });
    return response.output_text;
  },
});
