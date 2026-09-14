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

/**
 * A completion constrained to a JSON Schema.
 *
 * Uses `text.format` with `strict: true`, so the model cannot return prose or a
 * field the caller did not ask for, and a malformed response fails here rather
 * than somewhere downstream holding a half-parsed object.
 *
 * The schema crosses the wire as a string because Convex validators cannot
 * describe an arbitrary nested JSON Schema, and `v.any()` would drop the
 * typo-catching this is for. Callers hold the schema as a literal and stringify
 * it at the call site.
 */
export const structured = internalAction({
  args: {
    prompt: v.string(),
    schemaName: v.string(),
    schemaJson: v.string(),
    instructions: v.optional(v.string()),
    model: v.optional(v.string()),
  },
  returns: v.string(),
  handler: async (_ctx, args) => {
    const openai = new OpenAI({ apiKey: requireEnv("OPENAI_API_KEY") });

    const response = await openai.responses.create({
      model: args.model ?? "gpt-5.5",
      instructions: args.instructions,
      input: args.prompt,
      text: {
        format: {
          type: "json_schema",
          name: args.schemaName,
          schema: JSON.parse(args.schemaJson) as Record<string, unknown>,
          strict: true,
        },
      },
    });

    // Returned as a string rather than parsed: the caller knows the shape it
    // asked for, and re-validating a parsed object through a Convex validator
    // here would mean describing every schema twice.
    return response.output_text;
  },
});
