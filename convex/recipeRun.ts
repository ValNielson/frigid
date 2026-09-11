"use node";

/**
 * The recipe pipeline: search, read, shop, email.
 *
 * Four actions chained through the scheduler rather than a workflow component.
 * The job row is both the state machine and the UI model, and every step wraps
 * itself in try/catch — Convex does not retry a scheduled action, so a step
 * that throws without marking the job failed would leave it "reading" forever
 * and the screen spinning.
 *
 * Retries are deliberately absent for the same reason a workflow engine is:
 * every retry spends Firecrawl credits, and a budget that can be spent twice
 * by accident is not a budget.
 */

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { optionalEnv, requireEnv } from "./env";
import {
  DOMAIN_SET_TAG,
  RECIPE_DOMAINS,
  STORE_CATALOG,
  departmentFor,
} from "./recipeCatalog";
import {
  LLM_MARKDOWN_WINDOW,
  MAX_ITEMS_PER_STORE_PROBE,
  MAX_LLM_CALLS_PER_JOB,
  MAX_SCRAPES_PER_JOB,
  MAX_STORE_PROBES,
  RECIPES_PER_JOB,
  SCRAPE_SPACING_MS,
  SEARCH_LIMIT,
} from "./recipePolicy";
import {
  buildSearchQuery,
  containsAllergen,
  dedupeIngredients,
  domainOf,
  normalizeQuery,
  normalizeUrl,
  parseIngredientLine,
  scoreCandidate,
  slugifyItem,
  type Ingredient,
} from "./recipeText";
import { ingredientsFromMarkdown, recipeFromHtml } from "./recipeJsonLd";
import { realAllergies } from "./onboardingSummary";
import { renderRecipeHtml, renderRecipeText } from "./recipeEmail";
import type { GenericActionCtx } from "convex/server";
import type { DataModel, Id } from "./_generated/dataModel";

type Ctx = GenericActionCtx<DataModel>;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs a step, and makes sure a thrown error becomes a failed job rather than
 * a job that never moves again.
 */
async function guard(
  ctx: Ctx,
  jobId: Id<"recipeJobs">,
  step: () => Promise<void>,
): Promise<null> {
  try {
    await step();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.runMutation(internal.recipeJobs.markFailed, { jobId, error: message });
  }
  return null;
}

// ------------------------------------------------------------------- 1. search

export const search = internalAction({
  args: { jobId: v.id("recipeJobs") },
  returns: v.null(),
  handler: async (ctx, args) =>
    guard(ctx, args.jobId, async () => {
      const job = await ctx.runQuery(internal.recipeJobs.forRun, { jobId: args.jobId });
      if (job === null) throw new Error("This search is no longer available.");

      await ctx.runMutation(internal.recipeJobs.markStatus, {
        jobId: args.jobId,
        status: "searching",
        statusDetail: "Looking for recipes that fit your profile",
      });

      const query = buildSearchQuery(job.prompt, job.answers);
      const queryKey = `${normalizeQuery(query)}|${DOMAIN_SET_TAG}|${SEARCH_LIMIT}`;

      const found = await ctx.runAction(internal.firecrawlClient.searchWeb, {
        query,
        queryKey,
        includeDomains: [...RECIPE_DOMAINS],
        limit: SEARCH_LIMIT,
      });

      // includeDomains is a hint, not a filter — we have seen YouTube come back
      // from a domain-restricted search — so enforce the allowlist ourselves.
      // It is also what guarantees every candidate publishes recipe JSON-LD.
      const allowed = found.results.filter((result) => {
        const domain = domainOf(result.url);
        return RECIPE_DOMAINS.some(
          (allowedDomain) =>
            domain === allowedDomain || domain.endsWith(`.${allowedDomain}`),
        );
      });

      const ranked = [...allowed].sort(
        (a, b) =>
          scoreCandidate(b, job.prompt, job.answers) -
          scoreCandidate(a, job.prompt, job.answers),
      );

      await ctx.runMutation(internal.recipeJobs.setCandidates, {
        jobId: args.jobId,
        searchQuery: query,
        candidates: ranked,
      });
      await ctx.runMutation(internal.recipeJobs.markStatus, {
        jobId: args.jobId,
        creditsDelta: found.creditsUsed,
      });

      if (ranked.length === 0) {
        throw new Error(
          "We could not find recipes for that. Try describing the dish a little differently.",
        );
      }

      await ctx.scheduler.runAfter(0, internal.recipeRun.readRecipes, {
        jobId: args.jobId,
      });
    }),
});

// -------------------------------------------------------------------- 2. read

/**
 * Gets ingredients out of a page, cheapest route first.
 *
 * JSON-LD covers every allowlisted domain, so the paid path should effectively
 * never run. When it does, that is worth noticing rather than quietly paying
 * for — hence the per-job cap and the kill switch.
 */
async function extractIngredients(
  ctx: Ctx,
  page: { rawHtml: string | null; markdown: string },
  llmCallsUsed: number,
): Promise<{
  ingredientsRaw: string[];
  source: "jsonld" | "markdown" | "llm";
  name?: string;
  image?: string;
  totalTimeMinutes?: number;
  servings?: string;
  llmUsed: number;
} | null> {
  if (page.rawHtml !== null) {
    const parsed = recipeFromHtml(page.rawHtml);
    if (parsed !== null) {
      return {
        ingredientsRaw: parsed.ingredientsRaw,
        source: "jsonld",
        name: parsed.name,
        ...(parsed.image !== undefined ? { image: parsed.image } : {}),
        ...(parsed.totalTimeMinutes !== undefined
          ? { totalTimeMinutes: parsed.totalTimeMinutes }
          : {}),
        ...(parsed.servings !== undefined ? { servings: parsed.servings } : {}),
        llmUsed: 0,
      };
    }
  }

  const fromMarkdown = ingredientsFromMarkdown(page.markdown);
  if (fromMarkdown.length >= 3) {
    return { ingredientsRaw: fromMarkdown, source: "markdown", llmUsed: 0 };
  }

  const fallbackEnabled = optionalEnv("RECIPE_LLM_FALLBACK", "on") !== "off";
  if (!fallbackEnabled || llmCallsUsed >= MAX_LLM_CALLS_PER_JOB) return null;

  // Window the markdown around the ingredients heading when we can find one,
  // so we pay for the part of the page that might actually contain the answer.
  const headingAt = page.markdown.search(/^#{1,4}\s*ingredients\b/im);
  const start = headingAt === -1 ? 0 : headingAt;
  const window = page.markdown.slice(start, start + LLM_MARKDOWN_WINDOW);

  const reply = await ctx.runAction(internal.openai.complete, {
    model: optionalEnv("RECIPE_EXTRACT_MODEL", "gpt-5.5"),
    instructions:
      "Return only the ingredient lines from this recipe, one per line. " +
      "No numbering, no headings, no prose, no commentary. " +
      "If there is no recipe, return nothing.",
    prompt: window,
    maxOutputTokens: 400,
  });

  const lines = reply
    .split("\n")
    .map((line) => line.replace(/^[-*\d.)\s]+/, "").trim())
    .filter((line) => line.length > 0 && line.length <= 160);

  if (lines.length < 3) return null;
  return { ingredientsRaw: lines, source: "llm", llmUsed: 1 };
}

export const readRecipes = internalAction({
  args: { jobId: v.id("recipeJobs") },
  returns: v.null(),
  handler: async (ctx, args) =>
    guard(ctx, args.jobId, async () => {
      const job = await ctx.runQuery(internal.recipeJobs.forRun, { jobId: args.jobId });
      if (job === null) throw new Error("This search is no longer available.");

      const allergies = realAllergies(job.answers);
      let accepted = 0;
      let scrapes = 0;
      let llmCallsUsed = job.llmCallsUsed;

      for (const candidate of job.candidates) {
        if (accepted >= RECIPES_PER_JOB || scrapes >= MAX_SCRAPES_PER_JOB) break;

        await ctx.runMutation(internal.recipeJobs.markStatus, {
          jobId: args.jobId,
          status: "reading",
          statusDetail: `Reading recipe ${accepted + 1} of ${RECIPES_PER_JOB}`,
        });

        const urlKey = normalizeUrl(candidate.url);

        // A recipe we have already parsed costs nothing and skips the scrape
        // entirely. This is the cache that makes repeat searches free.
        const cached = await ctx.runQuery(internal.recipeCache.getRecipe, { urlKey });
        if (cached !== null) {
          const allergen = containsAllergen(cached.ingredients, allergies);
          if (allergen !== null) {
            await ctx.runMutation(internal.recipeJobs.addSkipped, {
              jobId: args.jobId,
              url: cached.url,
              reason: `Contains ${allergen.toLowerCase()}`,
            });
            continue;
          }
          // `domain` is a cache-only field; the job row does not carry it.
          const { domain, ...recipe } = cached;
          void domain;
          await ctx.runMutation(internal.recipeJobs.addRecipe, {
            jobId: args.jobId,
            recipe,
          });
          accepted += 1;
          continue;
        }

        // Pace rather than burst: the free tier allows 10 requests a minute and
        // we have measured it rejecting bursts. A rejection still costs time.
        if (scrapes > 0) await pause(SCRAPE_SPACING_MS);

        const page = await ctx.runAction(internal.firecrawlClient.scrapePage, {
          url: candidate.url,
          urlKey,
        });
        scrapes += 1;
        await ctx.runMutation(internal.recipeJobs.markStatus, {
          jobId: args.jobId,
          creditsDelta: page.creditsUsed,
        });

        if (page.blocked) {
          await ctx.runMutation(internal.recipeJobs.addSkipped, {
            jobId: args.jobId,
            url: candidate.url,
            reason: "The site would not let us read it",
          });
          continue;
        }

        const extracted = await extractIngredients(ctx, page, llmCallsUsed);
        if (extracted === null) {
          await ctx.runMutation(internal.recipeJobs.addSkipped, {
            jobId: args.jobId,
            url: candidate.url,
            reason: "We could not read an ingredient list",
          });
          continue;
        }
        if (extracted.llmUsed > 0) {
          llmCallsUsed += extracted.llmUsed;
          await ctx.runMutation(internal.recipeJobs.markStatus, {
            jobId: args.jobId,
            llmDelta: extracted.llmUsed,
          });
        }

        const ingredients = extracted.ingredientsRaw.map(parseIngredientLine);
        const recipe = {
          url: candidate.url,
          name: extracted.name ?? page.title ?? candidate.title,
          ...(extracted.image !== undefined ? { image: extracted.image } : {}),
          ...(extracted.totalTimeMinutes !== undefined
            ? { totalTimeMinutes: extracted.totalTimeMinutes }
            : {}),
          ...(extracted.servings !== undefined ? { servings: extracted.servings } : {}),
          source: extracted.source,
          ingredients,
        };

        // Cache before the allergen gate: the parse is expensive and correct
        // regardless of who asked, and the gate is per-user.
        await ctx.runMutation(internal.recipeCache.putRecipe, {
          urlKey,
          recipe: { ...recipe, domain: domainOf(candidate.url) },
        });

        const allergen = containsAllergen(ingredients, allergies);
        if (allergen !== null) {
          await ctx.runMutation(internal.recipeJobs.addSkipped, {
            jobId: args.jobId,
            url: candidate.url,
            reason: `Contains ${allergen.toLowerCase()}`,
          });
          continue;
        }

        await ctx.runMutation(internal.recipeJobs.addRecipe, {
          jobId: args.jobId,
          recipe,
        });
        accepted += 1;
      }

      if (accepted === 0) {
        // Distinguish "nothing was safe for you" from "the sites would not
        // cooperate". The first is a real answer about the recipes we found and
        // the user should hear it as one, not as a generic failure.
        const job2 = await ctx.runQuery(internal.recipeJobs.forRun, {
          jobId: args.jobId,
        });
        const skipped = job2?.skipped ?? [];
        const allergenDrops = skipped.filter((entry) =>
          entry.reason.startsWith("Contains"),
        ).length;

        throw new Error(
          allergenDrops > 0 && allergenDrops === skipped.length
            ? `Every recipe we found clashed with your allergies, so we did not send any. Try naming a different dish.`
            : "We found recipes but could not read any that fit your profile. Try a different description.",
        );
      }

      await ctx.scheduler.runAfter(0, internal.recipeRun.shop, { jobId: args.jobId });
    }),
});

// -------------------------------------------------------------------- 3. shop

/** The user's chosen stores, in the order the question offered them. */
function storesFor(answers: Record<string, { choices: string[] }>) {
  const chosen = answers["stores"]?.choices ?? [];
  const entries = STORE_CATALOG.filter((store) => chosen.includes(store.label));
  // Everyone gets at least one store to look at, or the shopping list is just
  // a list of words.
  return entries.length > 0 ? entries : STORE_CATALOG.slice(0, 1);
}

export const shop = internalAction({
  args: { jobId: v.id("recipeJobs") },
  returns: v.null(),
  handler: async (ctx, args) =>
    guard(ctx, args.jobId, async () => {
      const job = await ctx.runQuery(internal.recipeJobs.forRun, { jobId: args.jobId });
      if (job === null) throw new Error("This search is no longer available.");

      await ctx.runMutation(internal.recipeJobs.markStatus, {
        jobId: args.jobId,
        status: "shopping",
        statusDetail: "Building your shopping list",
      });

      const staples = job.answers["staples"]?.choices ?? [];
      const items = dedupeIngredients(
        job.recipes.map((recipe) => ({
          name: recipe.name,
          ingredients: recipe.ingredients as Ingredient[],
        })),
        departmentFor,
        staples,
      );

      const stores = storesFor(job.answers);

      type StoreSlot = {
        storeSlug: string;
        storeLabel: string;
        searchUrl?: string;
        productTitle?: string;
        productUrl?: string;
      };

      // Every item always gets a store name and a working search link. That
      // costs nothing, never breaks, and is most of what the user wanted. The
      // live probe below only ever adds a product name on top.
      const shopping: {
        item: string;
        usedIn: string[];
        department: string;
        stores: StoreSlot[];
      }[] = items.map((item) => ({
        ...item,
        stores: stores.map((store) => ({
          storeSlug: store.slug,
          storeLabel: store.label,
          ...(store.search !== null ? { searchUrl: store.search(item.item) } : {}),
        })),
      }));

      // One probe per store, naming several items at once, because search is
      // billed per call and not per term. We never fetch the retailer's own
      // page: the big chains sit behind bot walls that would bill us for a
      // CAPTCHA, but their product pages are in the search index all the same.
      const probeItems = shopping
        .filter((entry) => entry.department === "Meat & Seafood" || entry.usedIn.length > 1)
        .slice(0, MAX_ITEMS_PER_STORE_PROBE);

      for (const store of stores.slice(0, MAX_STORE_PROBES)) {
        if (store.domain === null || probeItems.length === 0) continue;

        try {
          const query = probeItems.map((entry) => entry.item).join(" ");
          const queryKey = `store:${store.slug}|${normalizeQuery(query)}`;

          const found = await ctx.runAction(internal.firecrawlClient.searchWeb, {
            query,
            queryKey,
            includeDomains: [store.domain],
            limit: 10,
          });
          await ctx.runMutation(internal.recipeJobs.markStatus, {
            jobId: args.jobId,
            creditsDelta: found.creditsUsed,
          });

          for (const entry of probeItems) {
            const words = slugifyItem(entry.item).split("-").filter((w) => w.length > 2);
            if (words.length === 0) continue;

            const match = found.results.find((result) => {
              if (domainOf(result.url) === "") return false;
              const title = result.title.toLowerCase();
              return words.every((word) => title.includes(word));
            });
            if (match === undefined) continue;

            const target = shopping.find((row) => row.item === entry.item);
            const slot = target?.stores.find((s) => s.storeSlug === store.slug);
            if (slot !== undefined) {
              slot.productTitle = match.title;
              slot.productUrl = match.url;
            }
          }
        } catch {
          // A probe is a bonus. The template links above already work, so a
          // blocked or failing store must never cost the user their results.
        }
      }

      await ctx.runMutation(internal.recipeJobs.setShopping, {
        jobId: args.jobId,
        shopping,
      });

      await ctx.scheduler.runAfter(0, internal.recipeRun.email, { jobId: args.jobId });
    }),
});

// ------------------------------------------------------------------- 4. email

export const email = internalAction({
  args: { jobId: v.id("recipeJobs") },
  returns: v.null(),
  handler: async (ctx, args) =>
    guard(ctx, args.jobId, async () => {
      const job = await ctx.runQuery(internal.recipeJobs.forRun, { jobId: args.jobId });
      if (job === null) throw new Error("This search is no longer available.");

      // Someone who has opted out still gets their results on screen. They just
      // do not get mail, even mail they asked for a minute ago.
      if (!job.subscribed) {
        await ctx.runMutation(internal.recipeJobs.markDone, {
          jobId: args.jobId,
          emailed: false,
        });
        return;
      }

      await ctx.runMutation(internal.recipeJobs.markStatus, {
        jobId: args.jobId,
        status: "emailing",
        statusDetail: "Sending your results",
      });

      const siteUrl = requireEnv("CONVEX_SITE_URL").replace(/\/$/, "");
      const unsubscribeUrl = `${siteUrl}/unsubscribe?token=${encodeURIComponent(
        job.unsubscribeToken,
      )}`;

      const payload = {
        prompt: job.prompt,
        recipes: job.recipes,
        shopping: job.shopping,
      };

      await ctx.runAction(internal.agentmail.sendMessage, {
        inboxId: requireEnv("AGENTMAIL_INBOX_ID"),
        to: [job.email],
        subject:
          job.recipes.length === 1
            ? `A recipe for "${job.prompt}"`
            : `${job.recipes.length} recipes for "${job.prompt}"`,
        text: `${renderRecipeText(payload)}\n\nUnsubscribe: ${unsubscribeUrl}\n`,
        html: renderRecipeHtml(payload, unsubscribeUrl),
        headers: {
          "List-Unsubscribe": `<${unsubscribeUrl}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      });

      await ctx.runMutation(internal.recipeJobs.markDone, {
        jobId: args.jobId,
        emailed: true,
      });
    }),
});
