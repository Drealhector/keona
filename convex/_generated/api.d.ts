/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as alerts from "../alerts.js";
import type * as b64 from "../b64.js";
import type * as brain from "../brain.js";
import type * as chat from "../chat.js";
import type * as crons from "../crons.js";
import type * as eyes from "../eyes.js";
import type * as guards from "../guards.js";
import type * as http from "../http.js";
import type * as targets from "../targets.js";
import type * as watch from "../watch.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  alerts: typeof alerts;
  b64: typeof b64;
  brain: typeof brain;
  chat: typeof chat;
  crons: typeof crons;
  eyes: typeof eyes;
  guards: typeof guards;
  http: typeof http;
  targets: typeof targets;
  watch: typeof watch;
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

export declare const components: {};
