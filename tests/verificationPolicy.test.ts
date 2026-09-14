/**
 * The two pure helpers the auth path rests on.
 *
 * Small enough to look obviously correct, which is exactly why they were never
 * tested: normalizeEmail decides what an address even is, and constantTimeEquals
 * is the comparison that keeps a code from leaking through timing.
 */

import { test } from "vitest";
import assert from "node:assert/strict";

import { constantTimeEquals, normalizeEmail } from "../convex/policy.ts";

test("normalizeEmail trims and lowercases", () => {
  assert.equal(normalizeEmail("  Someone@Example.COM "), "someone@example.com");
});

test("normalizeEmail rejects what could never be an address", () => {
  for (const bad of ["", "   ", "someone", "someone@", "@example.com", "a@b", "two words@example.com", "someone@example"]) {
    assert.equal(normalizeEmail(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test("normalizeEmail rejects an address past the RFC length ceiling", () => {
  assert.equal(normalizeEmail(`${"a".repeat(250)}@example.com`), null);
  assert.notEqual(normalizeEmail(`${"a".repeat(60)}@example.com`), null);
});

test("normalizeEmail keeps plus tags, which the inbox strategy depends on", () => {
  assert.equal(normalizeEmail("Frigid+Meijer@agentmail.to"), "frigid+meijer@agentmail.to");
});

test("constantTimeEquals matches only identical strings", () => {
  assert.equal(constantTimeEquals("abc123", "abc123"), true);
  assert.equal(constantTimeEquals("abc123", "abc124"), false);
  assert.equal(constantTimeEquals("abc123", "ABC123"), false);
});

test("constantTimeEquals refuses a length mismatch rather than comparing", () => {
  assert.equal(constantTimeEquals("abc", "abcd"), false);
  assert.equal(constantTimeEquals("", ""), true);
});
