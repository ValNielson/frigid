"use node";

import Firecrawl from "firecrawl";
import { v } from "convex/values";
import { action } from "./_generated/server";
import { requireEnv } from "./env";

export const scrape = action({
  args: { url: v.string() },
  returns: v.object({
    markdown: v.string(),
    title: v.union(v.string(), v.null()),
    sourceUrl: v.union(v.string(), v.null()),
  }),
  handler: async (_ctx, args) => {
    const firecrawl = new Firecrawl({ apiKey: requireEnv("FIRECRAWL_API_KEY") });
    const document = await firecrawl.scrape(args.url, { formats: ["markdown"] });
    if (!document.markdown) {
      throw new Error(`Firecrawl returned no markdown for ${args.url}`);
    }
    return {
      markdown: document.markdown,
      title: document.metadata?.title ?? null,
      sourceUrl: document.metadata?.url ?? null,
    };
  },
});
