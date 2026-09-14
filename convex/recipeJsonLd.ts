/**
 * Pulls a schema.org/Recipe out of a page's raw HTML.
 *
 * This is the whole reason the pipeline costs almost nothing to run: every
 * mainstream recipe site publishes its ingredients as JSON-LD because Google
 * Rich Results demand it, so the data we want is already sitting in the page,
 * already structured, and reading it costs zero model tokens.
 *
 * Pure and runtime-agnostic (no DOM, no Node) so it runs anywhere and is
 * testable on a saved HTML string.
 */

export type ParsedRecipe = {
  name: string;
  image?: string;
  totalTimeMinutes?: number;
  servings?: string;
  ingredientsRaw: string[];
};

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Every <script type="application/ld+json"> payload, parsed.
 *
 * A page can carry several blocks and one of them being malformed is common,
 * so each is parsed independently and a failure only loses that block.
 */
export function extractJsonLdBlocks(html: string): unknown[] {
  const pattern =
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const blocks: unknown[] = [];

  for (const match of html.matchAll(pattern)) {
    const body = match[1];
    if (body === undefined) continue;
    try {
      // Sites occasionally wrap the payload in an HTML comment or CDATA guard.
      const cleaned = body
        .replace(/^\s*<!--/, "")
        .replace(/-->\s*$/, "")
        .replace(/^\s*\/\/\s*<!\[CDATA\[/, "")
        .replace(/\/\/\s*\]\]>\s*$/, "")
        .trim();
      if (cleaned.length === 0) continue;
      blocks.push(JSON.parse(cleaned));
    } catch {
      // A broken block tells us nothing; the next one may still be good.
    }
  }
  return blocks;
}

function hasType(node: Json, wanted: string): boolean {
  const raw = node["@type"];
  if (typeof raw === "string") return raw === wanted;
  if (Array.isArray(raw)) return raw.includes(wanted);
  return false;
}

/**
 * Depth-first hunt for the Recipe node.
 *
 * Sites nest it in wildly different ways — bare object, top-level array,
 * `@graph` (Yoast and friends), or inside an `itemListElement` — so we walk
 * rather than assume a shape.
 */
export function findRecipeNode(blocks: unknown[]): Json | null {
  const seen = new Set<unknown>();

  const walk = (node: unknown): Json | null => {
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = walk(child);
        if (found !== null) return found;
      }
      return null;
    }
    if (!isObject(node)) return null;
    if (seen.has(node)) return null;
    seen.add(node);

    if (hasType(node, "Recipe")) return node;

    for (const key of ["@graph", "itemListElement", "mainEntity", "mainEntityOfPage"]) {
      if (key in node) {
        const found = walk(node[key]);
        if (found !== null) return found;
      }
    }
    return null;
  };

  return walk(blocks);
}

/**
 * ISO-8601 duration to whole minutes.
 *
 * Both forms show up in the wild: Budget Bytes writes PT105M, The Kitchn
 * writes PT2700S for the same kind of field.
 */
export function parseIso8601Duration(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)?$/.exec(value.trim());
  if (match === null) return undefined;

  const [, days, hours, minutes, seconds] = match;
  const total =
    Number(days ?? 0) * 24 * 60 +
    Number(hours ?? 0) * 60 +
    Number(minutes ?? 0) +
    Number(seconds ?? 0) / 60;

  const rounded = Math.round(total);
  return rounded > 0 ? rounded : undefined;
}

/** First usable image URL. The field is string | {url} | ImageObject[] in practice. */
function firstImage(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = firstImage(entry);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (isObject(value) && typeof value["url"] === "string") return value["url"];
  return undefined;
}

/** recipeYield is a string, a number, or an array of both. Take the first scalar. */
function firstScalar(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = firstScalar(entry);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** A Recipe node is only useful to us if it actually lists ingredients. */
export function recipeFromNode(node: Json | null): ParsedRecipe | null {
  if (node === null) return null;

  const rawIngredients = node["recipeIngredient"] ?? node["ingredients"];
  if (!Array.isArray(rawIngredients)) return null;

  const ingredientsRaw = rawIngredients
    .filter((line): line is string => typeof line === "string")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0);
  if (ingredientsRaw.length === 0) return null;

  const name = firstScalar(node["name"]);
  if (name === undefined) return null;

  return {
    name,
    image: firstImage(node["image"]),
    totalTimeMinutes:
      parseIso8601Duration(node["totalTime"]) ??
      parseIso8601Duration(node["cookTime"]) ??
      parseIso8601Duration(node["prepTime"]),
    servings: firstScalar(node["recipeYield"]),
    ingredientsRaw,
  };
}

/** The whole free path, from page HTML to a recipe, in one call. */
export function recipeFromHtml(html: string): ParsedRecipe | null {
  return recipeFromNode(findRecipeNode(extractJsonLdBlocks(html)));
}

/**
 * Free fallback for a page with no usable JSON-LD: find the ingredients
 * heading in the markdown and take the list under it. Cheaper to try than the
 * model, and it works often enough to be worth the twenty lines.
 */
export function ingredientsFromMarkdown(markdown: string): string[] {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => /^#{1,4}\s*ingredients\b/i.test(line.trim()));
  if (start === -1) return [];

  const collected: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    // A new heading ends the ingredient list.
    if (/^#{1,4}\s/.test(trimmed)) break;

    const item = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(trimmed)?.[1];
    if (item === undefined) continue;

    // Long lines are prose or an instruction that happens to be bulleted.
    const cleaned = item.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`]/g, "").trim();
    if (cleaned.length === 0 || cleaned.length > 120) continue;
    collected.push(cleaned);
  }
  return collected;
}
