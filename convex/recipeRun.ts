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
  LOOKS_LIKE_ROUNDUP,
  NOT_A_PRODUCT,
  PRODUCT_PATH,
  RECIPE_DOMAINS,
  STORE_CATALOG,
  departmentFor,
} from "./recipeCatalog";
import {
  LLM_MARKDOWN_WINDOW,
  MAX_DEALS_PER_JOB,
  MAX_ITEMS_PER_STORE_PROBE,
  MAX_LLM_CALLS_PER_JOB,
  MAX_PER_DOMAIN,
  MAX_SCRAPES_PER_JOB,
  MAX_STORE_PROBES,
  RECIPES_PER_JOB,
  SEARCH_LIMIT,
} from "./recipePolicy";
import {
  excludeAllergens,
  locationKey,
  matchIngredients,
  splitStores,
} from "./deals/policy";
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
import {
  unsubscribeHeaders,
  unsubscribeLine,
  unsubscribeUrl,
} from "./emailShell";
import type { GenericActionCtx } from "convex/server";
import type { DataModel, Id } from "./_generated/dataModel";

type Ctx = GenericActionCtx<DataModel>;

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
        // Roundups rank well for vague prompts and carry no single recipe, so
        // dropping them here saves a credit each rather than discovering it
        // after we have already paid to scrape them.
        if (LOOKS_LIKE_ROUNDUP.test(result.url)) return false;
        const domain = domainOf(result.url);
        return RECIPE_DOMAINS.some(
          (allowedDomain) =>
            domain === allowedDomain || domain.endsWith(`.${allowedDomain}`),
        );
      });

      const byScore = [...allowed].sort(
        (a, b) =>
          scoreCandidate(b, job.prompt, job.answers) -
          scoreCandidate(a, job.prompt, job.answers),
      );

      // Spread the picks across sites. A domain-restricted search will happily
      // return four recipes from one blog, and three from three sites is the
      // better answer even when the fourth scored higher. Anything over the cap
      // goes to the back rather than in the bin, so it is still available if the
      // better-ranked pages turn out to be unreadable.
      const perDomain = new Map<string, number>();
      const preferred: typeof byScore = [];
      const overflow: typeof byScore = [];
      for (const result of byScore) {
        const domain = domainOf(result.url);
        const seen = perDomain.get(domain) ?? 0;
        if (seen < MAX_PER_DOMAIN) {
          perDomain.set(domain, seen + 1);
          preferred.push(result);
        } else {
          overflow.push(result);
        }
      }
      const ranked = [...preferred, ...overflow];

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

      // Items worth a live lookup: the proteins and the things several recipes
      // share. Probing all thirty would cost more than the whole rest of the job.
      const probeItems = shopping
        .filter((entry) => entry.department === "Meat & Seafood" || entry.usedIn.length > 1)
        .slice(0, MAX_ITEMS_PER_STORE_PROBE);

      const applyProduct = (
        item: string,
        storeSlug: string,
        product: { title: string; url: string },
      ) => {
        const slot = shopping
          .find((row) => row.item === item)
          ?.stores.find((entry) => entry.storeSlug === storeSlug);
        if (slot !== undefined) {
          slot.productTitle = product.title;
          slot.productUrl = product.url;
        }
      };

      for (const store of stores.slice(0, MAX_STORE_PROBES)) {
        if (store.domain === null || probeItems.length === 0) continue;

        try {
          // Per-item cache first, keyed by store and item rather than by this
          // job's particular basket. "beef chuck at Kroger" is the same answer
          // for everyone who ever asks, so it should be paid for once — caching
          // the whole basket instead means almost every run pays again.
          const misses: typeof probeItems = [];
          for (const entry of probeItems) {
            const lookupKey = `${store.slug}|${slugifyItem(entry.item)}|us`;
            const hit = await ctx.runQuery(internal.recipeCache.getStoreLookup, {
              lookupKey,
            });
            if (hit === null) {
              misses.push(entry);
              continue;
            }
            const product = hit.products[0];
            if (hit.status === "found" && product !== undefined) {
              applyProduct(entry.item, store.slug, product);
            }
          }
          if (misses.length === 0) continue;

          // One search naming everything we still need: search is billed per
          // call, not per term. We never fetch the retailer's own page — the
          // big chains sit behind bot walls that would bill us for a CAPTCHA,
          // but their product pages are in the search index all the same.
          const query = misses.map((entry) => entry.item).join(" ");
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

          for (const entry of misses) {
            const words = slugifyItem(entry.item).split("-").filter((w) => w.length > 2);

            const match =
              words.length === 0
                ? undefined
                : found.results.find((result) => {
                    if (domainOf(result.url) === "") return false;
                    // Retailers host recipes and buying guides on the same
                    // domain as their catalog. Naming one of those as the place
                    // to buy garlic is worse than saying nothing, so require
                    // something shaped like a product page and reject anything
                    // that reads as an article.
                    if (NOT_A_PRODUCT.test(result.title)) return false;
                    if (!PRODUCT_PATH.test(result.url)) return false;
                    return words.every((word) => result.title.toLowerCase().includes(word));
                  });

            const product =
              match === undefined ? null : { title: match.title, url: match.url };
            if (product !== null) applyProduct(entry.item, store.slug, product);

            // "This store has nothing for this" is worth remembering too.
            // Re-asking it every run is how a credit budget disappears.
            await ctx.runMutation(internal.recipeCache.putStoreLookup, {
              lookupKey: `${store.slug}|${slugifyItem(entry.item)}|us`,
              storeSlug: store.slug,
              itemSlug: slugifyItem(entry.item),
              status: product === null ? "none" : "found",
              products: product === null ? [] : [product],
            });
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

      await ctx.scheduler.runAfter(0, internal.recipeRun.attachDeals, {
        jobId: args.jobId,
      });
    }),
});

// ------------------------------------------------------------------- 4. deals

/**
 * Finds coupons covering this job's own shopping list.
 *
 * Two paths, and the difference is cost. A warm pool is a database read and a
 * substring match — microseconds, so it runs inline and the email goes out with
 * deals in it. A cold pool means nobody has scraped this city yet, which is a
 * real coupon run; that is scheduled rather than awaited, and the run releases
 * the email itself when it lands.
 *
 * Not wrapped in guard(): deals are a bonus and recipes are what the user asked
 * for, so every failure here still ends with the email scheduled rather than
 * with a failed job.
 */
export const attachDeals = internalAction({
  args: { jobId: v.id("recipeJobs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const toEmail = () =>
      ctx.scheduler.runAfter(0, internal.recipeRun.email, { jobId: args.jobId });

    try {
      const job = await ctx.runQuery(internal.recipeJobs.forRun, {
        jobId: args.jobId,
      });
      if (job === null) return null;

      const items = job.shopping.map((entry) => entry.item);
      if (items.length === 0) {
        await ctx.runMutation(internal.recipeJobs.setDeals, {
          jobId: args.jobId,
          deals: [],
        });
        await toEmail();
        return null;
      }

      const { domains } = splitStores(
        job.answers["stores"]?.choices ?? [],
      );

      // Read the location cache rather than resolving it. normalizeLocation
      // would spend an OpenAI call on a miss, and this step runs on every
      // recipe search — the warm path has to stay a database read or the whole
      // argument for doing it inline collapses.
      //
      // A city nobody has resolved yet simply has no pool, which falls through
      // to the cold path below; that run resolves and caches it on the way past.
      const location = job.answers["location"]?.other?.trim() ?? "";
      const metro =
        location.length === 0
          ? null
          : await ctx.runQuery(internal.deals.data.getLocation, {
              raw: location,
            });

      const pool =
        metro === null
          ? []
          : await readPool(
              ctx,
              job.userId,
              domains,
              locationKey(metro.city, metro.state),
            );

      if (pool.length > 0) {
        await ctx.runMutation(internal.recipeJobs.setDeals, {
          jobId: args.jobId,
          deals: await toDeals(ctx, pool, items, realAllergies(job.answers)),
        });
        await toEmail();
        return null;
      }

      // Nothing stored for this person's stores in their city yet. Worth one
      // real coupon run, if the guard that protects every other run allows it.
      const blocked =
        location.length === 0
          ? { error: "no location" }
          : await ctx.runQuery(internal.deals.data.runBlocked, {
              userId: job.userId,
              now: Date.now(),
            });

      if (blocked !== null) {
        await ctx.runMutation(internal.recipeJobs.setDeals, {
          jobId: args.jobId,
          deals: [],
        });
        await toEmail();
        return null;
      }

      await ctx.runMutation(internal.recipeJobs.markStatus, {
        jobId: args.jobId,
        status: "dealing",
        statusDetail: "Checking what is on sale near you",
      });

      const runId = await ctx.runMutation(internal.deals.data.startRun, {
        userId: job.userId,
        kind: "ingredients",
        trigger: "recipe-cold",
        now: Date.now(),
      });

      // Scheduled, not awaited. A cold city is several Firecrawl searches and a
      // planner call, which is long enough that nesting it inside this action
      // would risk the action budget and freeze the job's updatedAt.
      await ctx.scheduler.runAfter(0, internal.deals.run.execute, {
        userId: job.userId,
        runId,
        trigger: "recipe-cold",
        ingredients: items,
        sendEmail: false,
        recipeJobId: args.jobId,
      });

      return null;
    } catch {
      // Whatever went wrong, the recipes are already on the row.
      await ctx.runMutation(internal.recipeJobs.setDeals, {
        jobId: args.jobId,
        deals: [],
      });
      await toEmail();
      return null;
    }
  },
});

/**
 * The coupons this person may see, for the stores they named, in their own city.
 *
 * The metro matters here as much as the store list: a chain's weekly ad is
 * regional, and reading one city's prices as another's is what made a Cleveland
 * pool look warm enough to skip scraping Cleveland.
 */
async function readPool(
  ctx: Ctx,
  userId: Id<"users">,
  domains: string[],
  metroKey: string,
) {
  if (domains.length === 0) return [];
  const merchants = await ctx.runQuery(internal.deals.data.merchantsByDomains, {
    domains,
  });
  if (merchants.length === 0) return [];
  return await ctx.runQuery(internal.deals.data.couponsForUser, {
    userId,
    merchantIds: merchants.map((m: { _id: Id<"merchants"> }) => m._id),
    metroKey,
    now: Date.now(),
  });
}

type PoolCoupon = {
  merchantId: Id<"merchants">;
  title: string;
  details?: string;
  code?: string;
  discount?: string;
  itemTerms: string[];
  sourceUrl?: string;
};

/**
 * Pool to the handful worth printing.
 *
 * Allergens are excluded after matching and never delegated to a model, the
 * same order deals/match.ts uses and for the same reason.
 */
async function toDeals(
  ctx: Ctx,
  pool: PoolCoupon[],
  items: string[],
  allergies: string[],
) {
  const matched = excludeAllergens(matchIngredients(pool, items), allergies).slice(
    0,
    MAX_DEALS_PER_JOB,
  );
  if (matched.length === 0) return [];

  const names = await ctx.runQuery(internal.deals.data.merchantNamesByIds, {
    merchantIds: matched.map((coupon) => coupon.merchantId),
  });
  const nameFor = new Map(
    names.map((row: { _id: Id<"merchants">; name: string }) => [
      row._id,
      row.name,
    ]),
  );

  return matched.map((coupon) => ({
    title: coupon.title,
    discount: coupon.discount,
    details: coupon.details,
    code: coupon.code,
    sourceUrl: coupon.sourceUrl,
    merchantName: nameFor.get(coupon.merchantId),
  }));
}

// ------------------------------------------------------------------- 5. email

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

      const optOutUrl = unsubscribeUrl(job.unsubscribeToken);

      const payload = {
        prompt: job.prompt,
        recipes: job.recipes,
        shopping: job.shopping,
        deals: job.deals,
      };

      await ctx.runAction(internal.agentmail.sendMessage, {
        inboxId: requireEnv("AGENTMAIL_INBOX_ID"),
        to: [job.email],
        subject:
          job.recipes.length === 1
            ? `A recipe for "${job.prompt}"`
            : `${job.recipes.length} recipes for "${job.prompt}"`,
        text: `${renderRecipeText(payload)}\n\n${unsubscribeLine(optOutUrl)}\n`,
        html: renderRecipeHtml(payload, optOutUrl),
        headers: unsubscribeHeaders(optOutUrl),
      });

      await ctx.runMutation(internal.recipeJobs.markDone, {
        jobId: args.jobId,
        emailed: true,
      });
    }),
});
