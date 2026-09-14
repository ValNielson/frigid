/**
 * What counts as a food word, and where that knowledge comes from.
 *
 * The coupon pipeline used to answer "is this food?" with a denylist of product
 * names, which is unbounded by construction: it only ever grew after something
 * unwanted had already reached a user, and it still let a dog treat through.
 *
 * Food is the bounded side of that question, and this project already maintains
 * the vocabulary for it twice over — department keywords for the shopping list,
 * allergen terms for the safety filter. Both are exercised on every recipe
 * search, so they stay honest. This composes them into one set rather than
 * asking anyone to keep a third list by hand.
 *
 * The static set is the floor, not the ceiling: every recipe the product reads
 * contributes its parsed ingredients, so the vocabulary widens on its own as
 * people cook things nobody anticipated. See recipeCache.learnFoodWords.
 *
 * Pure, so both runtimes and the tests can read it.
 */

import { ALLERGEN_TERMS } from "./allergens";
import { DEPARTMENT_RULES } from "./recipeCatalog";
import { foodWords } from "./words";

function buildStaticVocabulary(): ReadonlySet<string> {
  const words = new Set<string>();
  const add = (phrase: string) => {
    for (const word of foodWords(phrase)) words.add(word);
  };

  for (const rule of DEPARTMENT_RULES) {
    for (const keyword of rule.keywords) add(keyword);
  }
  for (const terms of Object.values(ALLERGEN_TERMS)) {
    for (const term of terms) add(term);
  }
  return words;
}

/**
 * The floor. Roughly a couple of hundred words, derived rather than written,
 * so adding a department keyword widens this for free.
 */
export const STATIC_FOOD_WORDS: ReadonlySet<string> = buildStaticVocabulary();

/**
 * Whether anything in this text reads as a food we recognise.
 *
 * Deliberately generous — one recognised word is enough. It is a second opinion
 * on the extractor's own classification, not the decision itself, so being
 * broad here costs nothing and being narrow would drop real groceries.
 */
export function looksLikeFood(
  text: string,
  learned: ReadonlySet<string> = new Set(),
): boolean {
  return foodWords(text).some(
    (word) => STATIC_FOOD_WORDS.has(word) || learned.has(word),
  );
}
