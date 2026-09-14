/**
 * Renders a finished recipe job as text and HTML.
 *
 * Pure, like onboardingSummary.ts, and for the same reason: the home screen
 * renders from the identical data shape, so what the user reads on the page and
 * what arrives in their inbox cannot drift apart. No model is involved — this
 * is a template, and templates do not cost anything or hallucinate a recipe.
 *
 * Deliberately never prints a price. We cannot verify one without knowing the
 * user's specific store, and a wrong price in an email is how the whole feature
 * starts feeling untrustworthy.
 */

import { emailCard, escapeHtml, safeHref } from "./emailShell";

export type EmailRecipe = {
  url: string;
  name: string;
  image?: string;
  totalTimeMinutes?: number;
  servings?: string;
  ingredients: { raw: string; item: string; quantity?: string }[];
};

export type EmailStore = {
  storeSlug: string;
  storeLabel: string;
  searchUrl?: string;
  productTitle?: string;
  productUrl?: string;
};

export type EmailShoppingItem = {
  item: string;
  usedIn: string[];
  department: string;
  stores: EmailStore[];
};

export type EmailDeal = {
  title: string;
  discount?: string;
  details?: string;
  code?: string;
  sourceUrl?: string;
  merchantName?: string;
};

export type RecipeEmailPayload = {
  prompt: string;
  recipes: EmailRecipe[];
  shopping: EmailShoppingItem[];
  /** Coupons covering this list. Absent on jobs from before the deals step. */
  deals?: EmailDeal[];
};

/** "chicken thighs" reads better as "Chicken thighs" at the start of a line. */
function sentenceCase(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);
}

function formatTime(minutes: number | undefined): string | null {
  if (minutes === undefined || minutes <= 0) return null;
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}

function recipeMeta(recipe: EmailRecipe): string {
  const bits = [formatTime(recipe.totalTimeMinutes)];
  if (recipe.servings !== undefined) bits.push(`serves ${recipe.servings}`);
  bits.push(`${recipe.ingredients.length} ingredients`);
  return bits.filter((bit): bit is string => bit !== null).join(" · ");
}

/** Preserves the department grouping the shopping list was already sorted into. */
function byDepartment(
  shopping: readonly EmailShoppingItem[],
): { department: string; items: EmailShoppingItem[] }[] {
  const groups: { department: string; items: EmailShoppingItem[] }[] = [];
  for (const item of shopping) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.department === item.department) last.items.push(item);
    else groups.push({ department: item.department, items: [item] });
  }
  return groups;
}

/** The one store line we print per item: a real product beats a search link. */
function storeNote(item: EmailShoppingItem): EmailStore | undefined {
  return (
    item.stores.find((store) => store.productUrl !== undefined) ??
    item.stores.find((store) => store.searchUrl !== undefined) ??
    item.stores[0]
  );
}

export function renderRecipeText(payload: RecipeEmailPayload): string {
  const lines: string[] = [];

  lines.push(`Here is what we found for "${payload.prompt}".`, "");

  for (const recipe of payload.recipes) {
    lines.push(recipe.name, `  ${recipeMeta(recipe)}`, `  ${recipe.url}`, "");
  }

  if (payload.shopping.length > 0) {
    lines.push(
      "WHAT TO SHOP FOR",
      `${payload.shopping.length} things, already combined across all ${payload.recipes.length} recipes.`,
      "",
    );

    for (const group of byDepartment(payload.shopping)) {
      lines.push(group.department.toUpperCase());
      for (const item of group.items) {
        const shared =
          item.usedIn.length > 1 ? ` (used in ${item.usedIn.length} recipes)` : "";
        lines.push(`  - ${sentenceCase(item.item)}${shared}`);

        const store = storeNote(item);
        if (store?.productTitle !== undefined && store.productUrl !== undefined) {
          lines.push(`      ${store.storeLabel}: ${store.productTitle}`);
          lines.push(`      ${store.productUrl}`);
        } else if (store?.searchUrl !== undefined) {
          lines.push(`      Find at ${store.storeLabel}: ${store.searchUrl}`);
        } else if (store !== undefined) {
          lines.push(`      Try ${store.storeLabel}`);
        }
      }
      lines.push("");
    }
  }

  const deals = payload.deals ?? [];
  if (deals.length > 0) {
    lines.push("ON SALE FOR THIS LIST", "");
    for (const deal of deals) {
      const price = deal.discount === undefined ? "" : ` - ${deal.discount}`;
      const where = deal.merchantName === undefined ? "" : ` at ${deal.merchantName}`;
      lines.push(`  ${deal.title}${price}${where}`);
      if (deal.code !== undefined) lines.push(`      Code: ${deal.code}`);
      const href = safeHref(deal.sourceUrl);
      if (href !== null) lines.push(`      ${href}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

export function renderRecipeHtml(
  payload: RecipeEmailPayload,
  unsubscribeUrl: string,
): string {
  const recipeCards = payload.recipes
    .map(
      (recipe) => `
      <div style="margin:0 0 14px;padding:16px;border:1px solid #dbe7ef;border-radius:12px;">
        <a href="${escapeHtml(recipe.url)}" style="font-size:16px;font-weight:600;color:#0f1b24;text-decoration:none;">${escapeHtml(recipe.name)}</a>
        <p style="margin:6px 0 0;font-size:13px;color:#5d7c8f;">${escapeHtml(recipeMeta(recipe))}</p>
      </div>`,
    )
    .join("");

  const shoppingGroups = byDepartment(payload.shopping)
    .map((group) => {
      const rows = group.items
        .map((item) => {
          const store = storeNote(item);
          const shared =
            item.usedIn.length > 1
              ? `<span style="color:#5d7c8f;font-size:12px;"> · in ${item.usedIn.length} recipes</span>`
              : "";

          let note = "";
          if (store?.productTitle !== undefined && store.productUrl !== undefined) {
            note = `<div style="font-size:12px;color:#5d7c8f;margin-top:2px;">${escapeHtml(store.storeLabel)}: <a href="${escapeHtml(store.productUrl)}" style="color:#2f8fbf;">${escapeHtml(store.productTitle)}</a></div>`;
          } else if (store?.searchUrl !== undefined) {
            note = `<div style="font-size:12px;color:#5d7c8f;margin-top:2px;"><a href="${escapeHtml(store.searchUrl)}" style="color:#2f8fbf;">Find at ${escapeHtml(store.storeLabel)}</a></div>`;
          } else if (store !== undefined) {
            note = `<div style="font-size:12px;color:#5d7c8f;margin-top:2px;">Try ${escapeHtml(store.storeLabel)}</div>`;
          }

          return `
        <tr>
          <td style="padding:7px 0;font-size:14px;color:#0f1b24;border-bottom:1px solid #eef4f8;">
            ${escapeHtml(sentenceCase(item.item))}${shared}${note}
          </td>
        </tr>`;
        })
        .join("");

      return `
      <h3 style="margin:22px 0 4px;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#2f8fbf;">${escapeHtml(group.department)}</h3>
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;">${rows}</table>`;
    })
    .join("");

  const shoppingSection =
    payload.shopping.length === 0
      ? ""
      : `
      <h2 style="margin:32px 0 4px;font-size:18px;">What to shop for</h2>
      <p style="margin:0 0 4px;font-size:13px;color:#5d7c8f;">
        ${payload.shopping.length} things, already combined across all ${payload.recipes.length} recipes.
      </p>
      ${shoppingGroups}`;

  const deals = payload.deals ?? [];
  const dealsSection =
    deals.length === 0
      ? ""
      : `
      <h2 style="margin:32px 0 4px;font-size:18px;">On sale for this list</h2>
      <p style="margin:0 0 8px;font-size:13px;color:#5d7c8f;">
        Matched against what you need to buy, at the stores you shop.
      </p>
      <ul style="margin:0;padding:0;">${deals
        .map((deal) => {
          const price =
            deal.discount === undefined
              ? ""
              : `<span style="margin-left:8px;padding:2px 8px;border-radius:999px;background:#eaf5ec;color:#2f6b43;font-size:13px;font-weight:600;">${escapeHtml(deal.discount)}</span>`;
          const where =
            deal.merchantName === undefined
              ? ""
              : `<span style="color:#5d7c8f;font-size:12px;"> at ${escapeHtml(deal.merchantName)}</span>`;
          const code =
            deal.code === undefined
              ? ""
              : `<div style="font-size:12px;color:#3d5666;margin-top:2px;">Code <strong style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${escapeHtml(deal.code)}</strong></div>`;
          // Source URLs come from Firecrawl results, so the scheme is not ours
          // to assume. An unlinked title beats a link we did not vet.
          const href = safeHref(deal.sourceUrl);
          const title =
            href === null
              ? escapeHtml(deal.title)
              : `<a href="${escapeHtml(href)}" style="color:#0f1b24;">${escapeHtml(deal.title)}</a>`;
          return `<li style="margin:0 0 10px;padding:0 0 10px;border-bottom:1px solid #eef4f8;list-style:none;">
            <div style="font-size:14px;">${title}${price}${where}</div>${code}
          </li>`;
        })
        .join("")}</ul>`;

  return emailCard({
    title: "Here is what we found",
    unsubscribeUrl,
    footer:
      "Store links go to that store's own search, so they work wherever you shop. " +
      "We do not quote prices we have not checked.",
    body: `
      <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#3d5666;">
        You asked for ${escapeHtml(payload.prompt)}.
      </p>
      ${recipeCards}
      ${shoppingSection}
      ${dealsSection}`,
  });
}
