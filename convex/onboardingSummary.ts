/**
 * Turns onboarding answers into the three things we need from them. All pure,
 * all synchronous, no network, no model calls — the report is a template, so
 * onboarding costs zero OpenAI tokens.
 *
 * Runtime-agnostic, like onboardingQuestions.ts, because the wizard renders a
 * live preview from the same functions the server uses for the email. The
 * screen and the email cannot drift because they are the same code.
 */

import {
  NO_ALLERGIES,
  QUESTIONS,
  SECTIONS,
  answerValues,
  type Answers,
} from "./onboardingQuestions";

/**
 * "a, b and c" — reads better in a report than a bare comma list.
 *
 * Falls back to plain commas when an item already contains "and", because
 * "Dinner and Batch cooking and meal prep" cannot be parsed by a reader.
 */
function list(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.some((i) => / and /.test(i))) return items.join(", ");
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function lower(items: string[]): string[] {
  // Proper nouns (cuisines, store names) keep their capitals; sentence-case
  // options like "Under 20 minutes" should not shout mid-sentence.
  return items.map((s) => (/^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s));
}

/** Allergies minus the "none" opt-out, which is an answer but not an allergen. */
export function realAllergies(answers: Answers): string[] {
  return answerValues(answers["allergies"]).filter((a) => a !== NO_ALLERGIES);
}

/**
 * The compact line injected into recipe prompts later.
 *
 * This is where the real token savings live: it is built once at onboarding and
 * cached on the preferences row, so every future recipe call pastes ~70 tokens
 * instead of re-deriving a profile from twenty stored answers.
 *
 * Allergies are rendered as an explicit hard rule and kept separate from
 * dislikes, so a downstream prompt can treat "will make them ill" differently
 * from "would rather not".
 */
export function buildPromptContext(answers: Answers): string {
  const parts: string[] = [];

  for (const question of QUESTIONS) {
    if (question.promptLabel === undefined) continue;
    if (question.id === "allergies") continue; // appended last, deliberately

    const values = answerValues(answers[question.id]);
    if (values.length === 0) continue;
    // Free text may already end in a full stop; the joiner adds its own.
    const joined = values.join(", ").replace(/[.\s]+$/, "");
    if (joined.length === 0) continue;
    parts.push(`${question.promptLabel}: ${joined}`);
  }

  const allergies = realAllergies(answers);
  // Always stated, even when empty, so a prompt reading this can tell "no
  // allergies" apart from "we never asked".
  parts.push(
    allergies.length > 0
      ? `ALLERGIES (hard rule, never suggest): ${allergies.join(", ")}`
      : "ALLERGIES: none reported",
  );

  return parts.join(". ") + ".";
}

/**
 * A few sentences of plain prose at the top of the report, assembled from the
 * answers that most shape what we will suggest.
 */
export function buildOpening(answers: Answers): string {
  const one = (id: string): string | undefined => answerValues(answers[id])[0];
  const many = (id: string): string[] => answerValues(answers[id]);

  const sentences: string[] = [];

  const household = one("householdSize");
  const location = one("location");
  if (household !== undefined || location !== undefined) {
    const who = household ? `Cooking for ${lower([household])[0]}` : "Cooking";
    sentences.push(location ? `${who} in ${location}.` : `${who}.`);
  }

  const time = one("weeknightTime");
  const skill = one("skill");
  if (time !== undefined || skill !== undefined) {
    const bits: string[] = [];
    if (time) bits.push(`you have ${lower([time])[0]}`);
    if (skill) bits.push(`you are ${lower([skill])[0]}`);
    sentences.push(`On a normal weeknight ${bits.join(", and ")}.`);
  }

  const loves = many("cuisinesLove");
  const spice = one("spice");
  if (loves.length > 0) {
    const heat = spice ? ` Heat: ${lower([spice])[0]}.` : "";
    sentences.push(`You lean toward ${list(loves)}.${heat}`);
  }

  const allergies = realAllergies(answers);
  if (allergies.length > 0) {
    sentences.push(
      `We will keep ${list(allergies)} out of everything we send you, without exception.`,
    );
  }

  return sentences.join(" ");
}

type Line = { label: string; value: string };

/** The report body, as section headings and answered lines. */
export function buildSections(answers: Answers): { title: string; lines: Line[] }[] {
  return SECTIONS.map((section) => {
    const lines: Line[] = [];
    for (const question of QUESTIONS) {
      if (question.section !== section) continue;
      const values = answerValues(answers[question.id]);
      if (values.length === 0) continue;
      lines.push({ label: question.prompt, value: list(values) });
    }
    return { title: section, lines };
  }).filter((s) => s.lines.length > 0);
}

export function renderSummaryText(answers: Answers): string {
  const out: string[] = ["Your frigid taste profile", ""];

  const opening = buildOpening(answers);
  if (opening.length > 0) out.push(opening, "");

  for (const section of buildSections(answers)) {
    out.push(section.title.toUpperCase());
    for (const line of section.lines) out.push(`  ${line.label}`, `    ${line.value}`);
    out.push("");
  }

  out.push(
    "You can change any of this later, and every recipe we send is shaped by it.",
  );
  return out.join("\n");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Email body. Inline styles with hardcoded hex, matching the palette in
 * globals.css, because Tailwind does not exist in a mail client — the same
 * approach verification.ts already takes for the code email.
 */
export function renderSummaryHtml(answers: Answers, unsubscribeUrl: string): string {
  const opening = buildOpening(answers);
  const allergies = realAllergies(answers);

  const sectionsHtml = buildSections(answers)
    .map((section) => {
      const rows = section.lines
        .map(
          (line) => `
        <tr>
          <td style="padding:6px 0;font-size:13px;color:#5d7c8f;width:45%;vertical-align:top;">${escapeHtml(line.label)}</td>
          <td style="padding:6px 0;font-size:14px;color:#0f1b24;vertical-align:top;">${escapeHtml(line.value)}</td>
        </tr>`,
        )
        .join("");
      return `
      <h2 style="margin:28px 0 8px;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#2f8fbf;">${escapeHtml(section.title)}</h2>
      <table style="width:100%;border-collapse:collapse;border-top:1px solid #e6eef4;">${rows}</table>`;
    })
    .join("");

  const allergyBanner =
    allergies.length > 0
      ? `<div style="margin:0 0 24px;padding:14px 16px;border-radius:12px;background:#fdf0ec;border:1px solid #f0c8bc;">
           <p style="margin:0;font-size:14px;line-height:1.5;color:#b93d29;">
             <strong>Allergies on file:</strong> ${escapeHtml(list(allergies))}. We treat these as a hard rule.
           </p>
         </div>`
      : "";

  return `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f4f8fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#0f1b24;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;padding:32px;border:1px solid #dbe7ef;">
      <p style="margin:0 0 8px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#5d7c8f;">frigid</p>
      <h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;">Your taste profile</h1>
      ${opening ? `<p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#3d5666;">${escapeHtml(opening)}</p>` : ""}
      ${allergyBanner}
      ${sectionsHtml}
      <hr style="border:none;border-top:1px solid #e6eef4;margin:32px 0 16px;" />
      <p style="margin:0 0 16px;font-size:13px;line-height:1.6;color:#5d7c8f;">
        Everything here shapes what we send you, and you can change it any time.
      </p>
      <p style="margin:0;font-size:12px;line-height:1.6;color:#7d97a7;">
        <a href="${escapeHtml(unsubscribeUrl)}" style="color:#7d97a7;">Unsubscribe from frigid emails</a>
      </p>
    </div>
  </body>
</html>`;
}
