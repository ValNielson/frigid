/**
 * Static tables the recipe pipeline runs on: which sites we search, which
 * stores we can link into, how ingredients map to departments, and which words
 * mean an allergen.
 *
 * Pure data and pure functions, no Convex or Node imports, so the wizard, the
 * home screen, the pipeline and the email can all share one source. Same
 * reasoning as onboardingQuestions.ts.
 */

/**
 * Sites we let the recipe search return.
 *
 * Every entry was verified by hand against the live Firecrawl API on
 * 2026-09-11: it must scrape successfully AND publish a schema.org/Recipe
 * block with `recipeIngredient`, because that JSON-LD is how we get ingredients
 * without paying an LLM. The list is deliberately short — a curated allowlist
 * keeps content farms and paywalls out of the results as a side effect.
 *
 * Known bad, do not re-add without re-testing:
 * - allrecipes.com, seriouseats.com, simplyrecipes.com — Firecrawl refuses
 *   these outright ("we do not support this site"). They are all Dotdash
 *   Meredith properties, so assume the rest of that portfolio is refused too
 *   (eatingwell, thespruceeats, southernliving, realsimple, marthastewart).
 * - smittenkitchen.com — scrapes fine but publishes no Recipe JSON-LD, so
 *   every page would fall through to the paid LLM path.
 */
export const RECIPE_DOMAINS: readonly string[] = [
  "budgetbytes.com",
  "thekitchn.com",
  "food.com",
  "loveandlemons.com",
  "cookieandkate.com",
  "sallysbakingaddiction.com",
  "delish.com",
  "halfbakedharvest.com",
  "minimalistbaker.com",
  "bonappetit.com",
];

/** Bumped whenever RECIPE_DOMAINS changes, so cached searches do not go stale. */
export const DOMAIN_SET_TAG = "recipes-v1";

export type StoreEntry = {
  /** Stable key for cache rows. Never change one without clearing storeLookups. */
  slug: string;
  /** Must match an option in the `stores` question exactly. */
  label: string;
  /** null for stores with no online catalog to link into. */
  domain: string | null;
  search: ((query: string) => string) | null;
};

const q = (s: string) => encodeURIComponent(s);

/**
 * One entry per option offered by the `stores` onboarding question, in the same
 * order, so "the user's top store" is well defined.
 *
 * `search` builds a link into the store's own search results rather than a
 * product page. That always resolves, needs no scraping, and does not go stale
 * the way a deep link to a single SKU would.
 */
export const STORE_CATALOG: readonly StoreEntry[] = [
  { slug: "aldi", label: "Aldi", domain: "aldi.us", search: (s) => `https://www.aldi.us/results?q=${q(s)}` },
  { slug: "costco", label: "Costco", domain: "costco.com", search: (s) => `https://www.costco.com/s?keyword=${q(s)}` },
  { slug: "kroger", label: "Kroger", domain: "kroger.com", search: (s) => `https://www.kroger.com/search?query=${q(s)}` },
  { slug: "meijer", label: "Meijer", domain: "meijer.com", search: (s) => `https://www.meijer.com/shopping/search.html?text=${q(s)}` },
  { slug: "trader-joes", label: "Trader Joe's", domain: "traderjoes.com", search: (s) => `https://www.traderjoes.com/home/search?q=${q(s)}` },
  { slug: "whole-foods", label: "Whole Foods", domain: "wholefoodsmarket.com", search: (s) => `https://www.wholefoodsmarket.com/search?text=${q(s)}` },
  { slug: "walmart", label: "Walmart", domain: "walmart.com", search: (s) => `https://www.walmart.com/search?q=${q(s)}` },
  { slug: "target", label: "Target", domain: "target.com", search: (s) => `https://www.target.com/s?searchTerm=${q(s)}` },
  { slug: "publix", label: "Publix", domain: "publix.com", search: (s) => `https://www.publix.com/search?query=${q(s)}` },
  { slug: "safeway", label: "Safeway or Albertsons", domain: "safeway.com", search: (s) => `https://www.safeway.com/shop/search-results.html?q=${q(s)}` },
  { slug: "heb", label: "H-E-B", domain: "heb.com", search: (s) => `https://www.heb.com/search?q=${q(s)}` },
  { slug: "wegmans", label: "Wegmans", domain: "wegmans.com", search: (s) => `https://shop.wegmans.com/search?search_term=${q(s)}` },
  // No national catalog to search. They still get named in the email, which is
  // the useful part — "the co-op probably has this" beats a broken link.
  { slug: "co-op", label: "Local co-op or farmers market", domain: null, search: null },
  { slug: "intl-market", label: "Asian or international market", domain: null, search: null },
];

export function storeForLabel(label: string): StoreEntry | undefined {
  return STORE_CATALOG.find((s) => s.label === label);
}

/**
 * Ingredient keyword to store department. First match wins, so the list is
 * ordered most specific first — "coconut milk" has to beat "coconut" into
 * produce, and "chicken broth" has to beat "chicken" into meat.
 */
export const DEPARTMENT_RULES: readonly { department: string; keywords: readonly string[] }[] = [
  {
    department: "Pantry",
    keywords: [
      "broth", "stock", "canned", "can of", "tomato paste", "tomato sauce", "coconut milk",
      "soy sauce", "fish sauce", "vinegar", "olive oil", "sesame oil", "vegetable oil",
      "flour", "sugar", "baking powder", "baking soda", "cornstarch", "honey", "maple syrup",
      "peanut butter", "pasta", "noodle", "rice", "quinoa", "lentil", "bean", "chickpea",
      "oats", "breadcrumb", "stock cube", "bouillon", "mayonnaise", "mustard", "ketchup",
      "hot sauce", "salsa", "tahini", "molasses", "vanilla extract", "cocoa", "chocolate chip",
    ],
  },
  {
    department: "Spices",
    keywords: [
      "salt", "pepper", "cumin", "paprika", "oregano", "thyme", "rosemary", "cinnamon",
      "nutmeg", "turmeric", "coriander", "cardamom", "chili powder", "cayenne", "bay leaf",
      "garam masala", "curry powder", "red pepper flake", "italian seasoning", "clove",
      "ginger powder", "onion powder", "garlic powder", "sage", "dill", "seasoning",
    ],
  },
  {
    department: "Meat & Seafood",
    keywords: [
      "chicken", "beef", "pork", "bacon", "sausage", "turkey", "lamb", "ground",
      "steak", "shrimp", "salmon", "tuna", "fish", "cod", "tilapia", "scallop",
      "crab", "lobster", "prosciutto", "chorizo", "pancetta", "ham",
    ],
  },
  {
    department: "Dairy & Eggs",
    keywords: [
      "milk", "butter", "cream", "cheese", "yogurt", "egg", "sour cream", "buttermilk",
      "parmesan", "mozzarella", "cheddar", "feta", "ricotta", "half and half", "ghee",
    ],
  },
  {
    department: "Produce",
    keywords: [
      "onion", "garlic", "carrot", "celery", "potato", "tomato", "lettuce", "spinach",
      "kale", "broccoli", "cauliflower", "pepper", "cucumber", "zucchini", "squash",
      "mushroom", "lemon", "lime", "orange", "apple", "banana", "avocado", "cilantro",
      "parsley", "basil", "mint", "scallion", "green onion", "shallot", "ginger",
      "cabbage", "corn", "pea", "green bean", "asparagus", "eggplant", "sweet potato",
      "berry", "grape", "herb", "sprout", "radish", "leek", "chive",
    ],
  },
  {
    department: "Frozen",
    keywords: ["frozen", "ice cream", "puff pastry"],
  },
  {
    department: "Bakery",
    keywords: ["bread", "tortilla", "bun", "roll", "pita", "baguette", "naan", "bagel"],
  },
];

/** Where to look for an ingredient. Falls back to a department that always exists. */
export function departmentFor(item: string): string {
  const haystack = item.toLowerCase();
  for (const rule of DEPARTMENT_RULES) {
    for (const keyword of rule.keywords) {
      if (haystack.includes(keyword)) return rule.department;
    }
  }
  return "Pantry";
}

/**
 * Allergy label to the words that betray it in an ingredient line.
 *
 * Keys match the options in the `allergies` question. This is deliberately
 * broad: a false positive costs the user one recipe, a false negative costs
 * them an allergic reaction, so the list errs toward dropping.
 */
export const ALLERGEN_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  Peanuts: ["peanut", "groundnut", "satay"],
  "Tree nuts": [
    "almond", "walnut", "pecan", "cashew", "pistachio", "hazelnut", "macadamia",
    "brazil nut", "pine nut", "nutella", "marzipan", "praline", "frangipane",
  ],
  "Milk or dairy": [
    "milk", "butter", "cream", "cheese", "yogurt", "yoghurt", "ghee", "custard",
    "parmesan", "mozzarella", "cheddar", "feta", "ricotta", "mascarpone",
    "buttermilk", "half and half", "whey", "casein",
  ],
  Eggs: ["egg", "mayonnaise", "meringue", "aioli", "albumen"],
  "Wheat or gluten": [
    "wheat", "flour", "barley", "rye", "bread", "pasta", "noodle", "couscous",
    "breadcrumb", "panko", "cracker", "tortilla", "seitan", "farro", "semolina",
    "spelt", "orzo", "phyllo", "puff pastry", "soy sauce",
  ],
  Soy: ["soy", "soya", "tofu", "edamame", "miso", "tempeh", "tamari"],
  Fish: [
    "fish", "salmon", "tuna", "cod", "tilapia", "anchovy", "anchovies",
    "sardine", "halibut", "trout", "mackerel", "worcestershire",
  ],
  Shellfish: [
    "shrimp", "prawn", "crab", "lobster", "clam", "mussel", "oyster",
    "scallop", "crawfish", "squid", "calamari", "octopus",
  ],
  Sesame: ["sesame", "tahini", "halva", "za'atar", "zaatar"],
  Mustard: ["mustard"],
  Celery: ["celery", "celeriac"],
  Sulfites: ["sulfite", "sulphite", "wine", "dried apricot"],
};

/**
 * Diet label to the term we append to the search query. Diets with no useful
 * search term, or that search cannot enforce anyway, are left out.
 */
export const DIET_SEARCH_TERMS: Readonly<Record<string, string>> = {
  Vegetarian: "vegetarian",
  Vegan: "vegan",
  Pescatarian: "pescatarian",
  "Gluten free": "gluten free",
  "Dairy free": "dairy free",
  "Keto or low carb": "keto",
  "Low sodium": "low sodium",
  "Paleo or Whole30": "paleo",
};

/** Weeknight-time answer to a search term. "I like a project" gets nothing. */
export const TIME_SEARCH_TERMS: Readonly<Record<string, string>> = {
  "Under 20 minutes": "quick",
  "20 to 40 minutes": "easy",
};
