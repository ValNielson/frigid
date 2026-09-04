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
import type * as env from "../env.js";
import type * as firecrawl from "../firecrawl.js";
import type * as hash from "../hash.js";
import type * as http from "../http.js";
import type * as me from "../me.js";
import type * as onboardingEmail from "../onboardingEmail.js";
import type * as onboardingQuestions from "../onboardingQuestions.js";
import type * as onboardingSummary from "../onboardingSummary.js";
import type * as openai from "../openai.js";
import type * as policy from "../policy.js";
import type * as preferences from "../preferences.js";
import type * as sessions from "../sessions.js";
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
  env: typeof env;
  firecrawl: typeof firecrawl;
  hash: typeof hash;
  http: typeof http;
  me: typeof me;
  onboardingEmail: typeof onboardingEmail;
  onboardingQuestions: typeof onboardingQuestions;
  onboardingSummary: typeof onboardingSummary;
  openai: typeof openai;
  policy: typeof policy;
  preferences: typeof preferences;
  sessions: typeof sessions;
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
