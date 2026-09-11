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

export type RecipeEmailPayload = {
  prompt: string;
  recipes: EmailRecipe[];
  shopping: EmailShoppingItem[];
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

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

  return `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f4f8fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#0f1b24;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;padding:32px;border:1px solid #dbe7ef;">
      <p style="margin:0 0 8px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#5d7c8f;">frigid</p>
      <h1 style="margin:0 0 6px;font-size:22px;">Here is what we found</h1>
      <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#3d5666;">
        You asked for ${escapeHtml(payload.prompt)}.
      </p>
      ${recipeCards}
      ${shoppingSection}
      <p style="margin:28px 0 0;font-size:12px;line-height:1.6;color:#7d97a7;">
        Store links go to that store's own search, so they work wherever you shop.
        We do not quote prices we have not checked.
      </p>
      <p style="margin:16px 0 0;font-size:12px;color:#7d97a7;">
        <a href="${escapeHtml(unsubscribeUrl)}" style="color:#7d97a7;">Unsubscribe from frigid emails</a>
      </p>
    </div>
  </body>
</html>`;
}
