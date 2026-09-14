// @vitest-environment edge-runtime

/**
 * The verification mutation, which is where a session is won or refused.
 *
 * Tested at the mutation layer rather than through verification.ts: the actions
 * there are "use node" for node:crypto, and the decision worth pinning down is
 * consumeCode's, not the SDK call around it.
 */

import { convexTest } from "convex-test";
import { beforeEach, expect, test } from "vitest";
import schema from "../convex/schema";
import { internal } from "../convex/_generated/api";
import {
  CODE_TTL_MS,
  MAX_VERIFY_ATTEMPTS,
  MAX_VERIFY_ATTEMPTS_PER_WINDOW,
  RESEND_COOLDOWN_MS,
  VERIFY_WINDOW_MS,
} from "../convex/policy";

const modules = import.meta.glob("../convex/**/*.ts");

const EMAIL = "someone@example.com";
const RIGHT = "a".repeat(64);
const WRONG = "b".repeat(64);
const START = 1_700_000_000_000;

beforeEach(() => {
  process.env.VERIFICATION_CODE_PEPPER = "test-pepper";
});

function harness() {
  return convexTest(schema, modules);
}

/** Puts an address in the state a user reaches by asking for a code. */
async function arm(
  t: ReturnType<typeof harness>,
  now: number,
  codeHash = RIGHT,
) {
  return await t.mutation(internal.users.issueCode, {
    email: EMAIL,
    codeHash,
    unsubscribeToken: "unsubscribe-token",
    now,
  });
}

const consume = (
  t: ReturnType<typeof harness>,
  codeHash: string,
  now: number,
) => t.mutation(internal.users.consumeCode, { email: EMAIL, codeHash, now });

test("an unknown address reads as a wrong code, not as unknown", async () => {
  const t = harness();
  expect(await consume(t, RIGHT, START)).toEqual({ status: "invalid" });
});

test("the armed code verifies", async () => {
  const t = harness();
  await arm(t, START);
  expect(await consume(t, RIGHT, START + 1_000)).toEqual({ status: "verified" });
});

/**
 * The regression test for the bug this suite was written around.
 *
 * consumeCode used to report "verified" whenever no code was armed and the
 * address had ever been verified — and verifyCode mints a session on that
 * status. Anyone who knew a registered address could sign in as them with any
 * code at all. A verified address with a spent code must refuse.
 */
test("a spent code does not verify a second time", async () => {
  const t = harness();
  await arm(t, START);
  expect(await consume(t, RIGHT, START + 1_000)).toEqual({ status: "verified" });

  expect(await consume(t, WRONG, START + 2_000)).toEqual({ status: "invalid" });
  expect(await consume(t, RIGHT, START + 3_000)).toEqual({ status: "invalid" });
  expect(await consume(t, "0".repeat(64), START + 4_000)).toEqual({
    status: "invalid",
  });
});

test("an address that was never armed does not verify", async () => {
  const t = harness();
  const userId = await t.run(async (ctx) =>
    ctx.db.insert("users", {
      email: EMAIL,
      verifiedAt: START,
      subscribed: true,
      unsubscribeToken: "unsubscribe-token",
      attemptsRemaining: 0,
      sendsInWindow: 0,
      windowStartedAt: START,
    }),
  );
  expect(userId).toBeDefined();
  expect(await consume(t, RIGHT, START + 1_000)).toEqual({ status: "invalid" });
});

test("a wrong code spends an attempt and then locks the code", async () => {
  const t = harness();
  await arm(t, START);

  for (let i = 1; i < MAX_VERIFY_ATTEMPTS; i += 1) {
    expect(await consume(t, WRONG, START + i)).toEqual({ status: "invalid" });
  }
  expect(await consume(t, WRONG, START + MAX_VERIFY_ATTEMPTS)).toEqual({
    status: "too_many_attempts",
  });

  // And the right code no longer helps, which is the point of the counter.
  expect(await consume(t, RIGHT, START + MAX_VERIFY_ATTEMPTS + 1)).toEqual({
    status: "too_many_attempts",
  });
});

test("an expired code reads as expired rather than wrong", async () => {
  const t = harness();
  await arm(t, START);
  expect(await consume(t, RIGHT, START + CODE_TTL_MS + 1)).toEqual({
    status: "expired",
  });
});

test("submissions are capped per window even with no code armed", async () => {
  const t = harness();
  await arm(t, START);
  await consume(t, RIGHT, START + 1);

  // The code is spent, so every one of these is an "invalid" that costs the
  // per-code counter nothing. Without the window cap they would be free.
  // Verifying reset the counter, so a full window's worth fits before the cap.
  for (let i = 0; i < MAX_VERIFY_ATTEMPTS_PER_WINDOW; i += 1) {
    expect(await consume(t, WRONG, START + 2 + i)).toEqual({
      status: "invalid",
    });
  }
  expect(
    await consume(t, WRONG, START + 2 + MAX_VERIFY_ATTEMPTS_PER_WINDOW),
  ).toEqual({ status: "too_many_attempts" });
});

test("the submission window rolls forward", async () => {
  const t = harness();
  await arm(t, START);
  for (let i = 0; i < MAX_VERIFY_ATTEMPTS_PER_WINDOW; i += 1) {
    await consume(t, WRONG, START + i);
  }
  expect(await consume(t, WRONG, START + 1)).toEqual({
    status: "too_many_attempts",
  });

  // A fresh code in a fresh window, and the address is usable again.
  const later = START + VERIFY_WINDOW_MS + 1;
  await arm(t, later);
  expect(await consume(t, RIGHT, later + 1)).toEqual({ status: "verified" });
});

test("a resend inside the cooldown leaves the armed code alone", async () => {
  const t = harness();
  await arm(t, START);
  const second = await arm(t, START + RESEND_COOLDOWN_MS / 2, WRONG);

  expect(second.send).toBe(false);
  // The original code still works: an impatient second request must not cut off
  // a user who is mid-way through typing the first one.
  expect(await consume(t, RIGHT, START + 1_000)).toEqual({ status: "verified" });
});
