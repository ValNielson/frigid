/**
 * Word normalizing shared by the two features that have to agree on whether two
 * food words are the same word.
 *
 * Recipe search needs it to key a store lookup ("tomatoes" and "tomato" are one
 * shelf); coupon matching needs it to decide whether an offer is for something
 * on the list. It lived inside recipeText.slugifyItem, which the coupon side
 * could not reach without depending on the recipe pipeline, so it moved here.
 *
 * Pure, no imports, so both runtimes and the browser bundle can read it.
 */

const IRREGULAR_SINGULARS: Record<string, string> = {
  leaves: "leaf", loaves: "loaf", potatoes: "potato", tomatoes: "tomato",
  berries: "berry", cherries: "cherry", anchovies: "anchovy",
};

/**
 * Crude, deliberately. English pluralization is not worth a library here, and
 * the cost of being wrong is one unmatched coupon.
 */
export function singular(word: string): string {
  const irregular = IRREGULAR_SINGULARS[word];
  if (irregular !== undefined) return irregular;
  if (word.endsWith("ss") || word.length <= 3) return word;
  if (word.endsWith("es") && /(?:ch|sh|x|s)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("s")) return word.slice(0, -1);
  return word;
}

/** A phrase as its significant, singularized words. */
export function foodWords(phrase: string): string[] {
  return phrase
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((word) => word.length > 2)
    .map(singular);
}

/**
 * Whether two food phrases name the same thing.
 *
 * Bidirectional on purpose: "cream cheese" should match an offer whose subject
 * is "cheese", and "chicken" should match one whose subject is "chicken breast".
 * Sharing any significant word is enough — which is also why this is applied to
 * an offer's single primary item rather than to everything it mentions.
 */
export function sharesFoodWord(a: string, b: string): boolean {
  const left = foodWords(a);
  if (left.length === 0) return false;
  const right = new Set(foodWords(b));
  return left.some((word) => right.has(word));
}
