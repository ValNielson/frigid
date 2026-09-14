/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as agentmail from "../agentmail.js";
import type * as agentmailEvents from "../agentmailEvents.js";
import type * as crons from "../crons.js";
import type * as deals from "../deals.js";
import type * as deals_data from "../deals/data.js";
import type * as deals_digest from "../deals/digest.js";
import type * as deals_match from "../deals/match.js";
import type * as deals_plan from "../deals/plan.js";
import type * as deals_policy from "../deals/policy.js";
import type * as deals_run from "../deals/run.js";
import type * as env from "../env.js";
import type * as firecrawl from "../firecrawl.js";
import type * as firecrawlClient from "../firecrawlClient.js";
import type * as fixtures_recipeFixtures from "../fixtures/recipeFixtures.js";
import type * as hash from "../hash.js";
import type * as http from "../http.js";
import type * as me from "../me.js";
import type * as onboardingEmail from "../onboardingEmail.js";
import type * as onboardingQuestions from "../onboardingQuestions.js";
import type * as onboardingSummary from "../onboardingSummary.js";
import type * as openai from "../openai.js";
import type * as policy from "../policy.js";
import type * as preferences from "../preferences.js";
import type * as recipeCache from "../recipeCache.js";
import type * as recipeCatalog from "../recipeCatalog.js";
import type * as recipeEmail from "../recipeEmail.js";
import type * as recipeJobs from "../recipeJobs.js";
import type * as recipeJsonLd from "../recipeJsonLd.js";
import type * as recipePolicy from "../recipePolicy.js";
import type * as recipeRun from "../recipeRun.js";
import type * as recipeText from "../recipeText.js";
import type * as sessions from "../sessions.js";
import type * as testSeed from "../testSeed.js";
import type * as users from "../users.js";
import type * as verification from "../verification.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  agentmail: typeof agentmail;
  agentmailEvents: typeof agentmailEvents;
  crons: typeof crons;
  deals: typeof deals;
  "deals/data": typeof deals_data;
  "deals/digest": typeof deals_digest;
  "deals/match": typeof deals_match;
  "deals/plan": typeof deals_plan;
  "deals/policy": typeof deals_policy;
  "deals/run": typeof deals_run;
  env: typeof env;
  firecrawl: typeof firecrawl;
  firecrawlClient: typeof firecrawlClient;
  "fixtures/recipeFixtures": typeof fixtures_recipeFixtures;
  hash: typeof hash;
  http: typeof http;
  me: typeof me;
  onboardingEmail: typeof onboardingEmail;
  onboardingQuestions: typeof onboardingQuestions;
  onboardingSummary: typeof onboardingSummary;
  openai: typeof openai;
  policy: typeof policy;
  preferences: typeof preferences;
  recipeCache: typeof recipeCache;
  recipeCatalog: typeof recipeCatalog;
  recipeEmail: typeof recipeEmail;
  recipeJobs: typeof recipeJobs;
  recipeJsonLd: typeof recipeJsonLd;
  recipePolicy: typeof recipePolicy;
  recipeRun: typeof recipeRun;
  recipeText: typeof recipeText;
  sessions: typeof sessions;
  testSeed: typeof testSeed;
  users: typeof users;
  verification: typeof verification;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  staticHosting: import("@convex-dev/static-hosting/_generated/component.js").ComponentApi<"staticHosting">;
};
