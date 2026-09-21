import type { NextConfig } from "next";

/**
 * Which backend the built bundle talks to.
 *
 * `NEXT_PUBLIC_*` values are inlined at build time, and `.env.local` holds the
 * *dev* deployment — so a plain `npm run deploy` would happily bake the dev URL
 * into the production bundle and the live site would read a dev database.
 *
 * The static-hosting CLI already knows the right answer and passes it to the
 * build as `VITE_CONVEX_URL` (its own convention, since it was written for
 * Vite). Preferring it here is what makes one deploy command correct.
 */
const convexUrl =
  process.env.VITE_CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL ?? "";

const nextConfig: NextConfig = {
  reactCompiler: true,

  env: { NEXT_PUBLIC_CONVEX_URL: convexUrl },

  /**
   * The deploy target is Convex static hosting, which serves files and runs no
   * Node process. `next build` therefore has to emit a static export into
   * `out/`, which is what `npm run deploy` uploads.
   *
   * Everything the app does at runtime already assumes this: routing is gated
   * in the browser, the session lives in localStorage rather than an httpOnly
   * cookie, and every read goes to Convex over its own client.
   */
  output: "export",

  /**
   * Image Optimization needs a server, so the default loader is unavailable
   * under a static export. The only image here is the logo, already sized and
   * checked in, so serving it as-is costs nothing.
   */
  images: { unoptimized: true },
};

export default nextConfig;
