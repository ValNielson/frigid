/**
 * The onboarding question bank.
 *
 * Runtime-agnostic in the same spirit as policy.ts — no Node imports, no Convex
 * imports — because three very different callers read it: the React wizard that
 * renders the questions, the mutation that validates what comes back, and the
 * summary renderer. One array means the UI, the validator, and the report can
 * never disagree about what a question is.
 */

export const SCHEMA_VERSION = 1;

/** Free-text answers are capped here and in the validating mutation. */
export const MAX_TEXT_LENGTH = 300;

export type QuestionKind = "single" | "multi" | "text";

export type Question = {
  id: string;
  section: string;
  prompt: string;
  help?: string;
  kind: QuestionKind;
  options?: readonly string[];
  /** Renders a "something else" text box alongside the options. */
  allowOther?: boolean;
  required?: boolean;
  /** Label used in the compact prompt context. Omit to leave it out entirely. */
  promptLabel?: string;
};

export type Answer = { choices: string[]; other?: string };
export type Answers = Record<string, Answer>;

export const SECTIONS = [
  "Staying in touch",
  "Where you shop",
  "How you cook",
  "What you like",
  "Ingredients",
  "Allergies and anything else",
] as const;

const CUISINES = [
  "Italian",
  "Mexican",
  "American comfort",
  "Mediterranean or Greek",
  "Middle Eastern",
  "Indian",
  "Thai",
  "Chinese",
  "Japanese",
  "Korean",
  "Vietnamese",
  "French",
  "Spanish",
  "Caribbean",
  "Southern and soul food",
  "Ethiopian",
  "Eastern European",
  "Barbecue",
] as const;

export const QUESTIONS: readonly Question[] = [
  // ---- Staying in touch -------------------------------------------------
  {
    id: "emailFrequency",
    section: "Staying in touch",
    prompt: "How often would you like to hear from us?",
    help: "Recipe ideas, seasonal picks, and what is worth buying this week.",
    kind: "single",
    required: true,
    options: [
      "Every day",
      "A few times a week",
      "Once a week",
      "Every other week",
      "Once a month",
      "Only when I ask",
    ],
  },
  {
    id: "emailTiming",
    section: "Staying in touch",
    prompt: "When is the best time to reach you?",
    kind: "single",
    options: [
      "Weekday mornings",
      "Weekday evenings",
      "Weekend mornings",
      "No preference",
    ],
  },

  // ---- Where you shop ---------------------------------------------------
  {
    id: "location",
    section: "Where you shop",
    prompt: "Where are you cooking from?",
    help: "City and state, or a ZIP code. We use it for what is in season near you and which stores carry what.",
    kind: "text",
    required: true,
    promptLabel: "Located in",
  },
  {
    id: "stores",
    section: "Where you shop",
    prompt: "Where do you usually buy groceries?",
    kind: "multi",
    allowOther: true,
    promptLabel: "Shops at",
    options: [
      "Aldi",
      "Costco",
      "Kroger",
      "Meijer",
      "Trader Joe's",
      "Whole Foods",
      "Walmart",
      "Target",
      "Publix",
      "Safeway or Albertsons",
      "H-E-B",
      "Wegmans",
      "Local co-op or farmers market",
      "Asian or international market",
    ],
  },
  {
    id: "budget",
    section: "Where you shop",
    prompt: "How much does price matter?",
    kind: "single",
    promptLabel: "Budget",
    options: [
      "Budget is the main thing",
      "Somewhere in the middle",
      "Happy to splurge sometimes",
      "Price is not a factor",
    ],
  },

  // ---- How you cook -----------------------------------------------------
  {
    id: "householdSize",
    section: "How you cook",
    prompt: "How many people are you usually cooking for?",
    kind: "single",
    promptLabel: "Cooks for",
    options: ["Just me", "Two of us", "Three or four", "Five or more"],
  },
  {
    id: "weeknightTime",
    section: "How you cook",
    prompt: "On a normal weeknight, how long do you want to spend cooking?",
    kind: "single",
    promptLabel: "Weeknight time",
    options: [
      "Under 20 minutes",
      "20 to 40 minutes",
      "40 to 60 minutes",
      "I like a project",
    ],
  },
  {
    id: "skill",
    section: "How you cook",
    prompt: "How would you describe your cooking?",
    kind: "single",
    promptLabel: "Skill level",
    options: [
      "Just starting out",
      "Comfortable with the basics",
      "Confident, I improvise",
      "I cook professionally",
    ],
  },
  {
    id: "equipment",
    section: "How you cook",
    prompt: "What do you have in your kitchen?",
    help: "We will not suggest a recipe that needs a tool you do not own.",
    kind: "multi",
    allowOther: true,
    promptLabel: "Equipment",
    options: [
      "Oven",
      "Stovetop",
      "Microwave",
      "Slow cooker",
      "Instant Pot or pressure cooker",
      "Air fryer",
      "Blender",
      "Food processor",
      "Stand mixer",
      "Outdoor grill",
      "Rice cooker",
      "Toaster oven",
    ],
  },
  {
    id: "mealTypes",
    section: "How you cook",
    prompt: "What do you want ideas for?",
    kind: "multi",
    promptLabel: "Wants ideas for",
    options: [
      "Breakfast",
      "Lunch",
      "Dinner",
      "Snacks",
      "Desserts",
      "Batch cooking and meal prep",
      "Drinks",
    ],
  },
  {
    id: "leftovers",
    section: "How you cook",
    prompt: "How do you feel about leftovers?",
    kind: "single",
    promptLabel: "Leftovers",
    options: [
      "Love them, cook once and eat twice",
      "They are fine sometimes",
      "I would rather cook fresh each time",
    ],
  },

  // ---- What you like ----------------------------------------------------
  {
    id: "cuisinesLove",
    section: "What you like",
    prompt: "Which cuisines do you love?",
    kind: "multi",
    allowOther: true,
    promptLabel: "Loves",
    options: CUISINES,
  },
  {
    id: "cuisinesAvoid",
    section: "What you like",
    prompt: "Any cuisines you would rather skip?",
    kind: "multi",
    allowOther: true,
    promptLabel: "Would rather skip",
    options: CUISINES,
  },
  {
    id: "spice",
    section: "What you like",
    prompt: "How much heat do you want?",
    kind: "single",
    promptLabel: "Spice level",
    options: ["No heat", "Mild", "Medium", "Hot", "The hotter the better"],
  },
  {
    id: "flavors",
    section: "What you like",
    prompt: "What flavors pull you in?",
    kind: "multi",
    promptLabel: "Flavors",
    options: [
      "Garlicky",
      "Herby and fresh",
      "Rich and creamy",
      "Bright and acidic",
      "Smoky",
      "Sweet and savory together",
      "Deeply savory and umami",
      "Simple, salt and pepper",
    ],
  },

  // ---- Ingredients ------------------------------------------------------
  {
    id: "staples",
    section: "Ingredients",
    prompt: "What do you almost always have on hand?",
    help: "This is what we reach for first when suggesting something to cook tonight.",
    kind: "multi",
    allowOther: true,
    promptLabel: "Usually has",
    options: [
      "Eggs",
      "Rice",
      "Pasta",
      "Potatoes",
      "Onions",
      "Garlic",
      "Canned tomatoes",
      "Beans",
      "Chicken",
      "Ground beef",
      "Butter",
      "Olive oil",
      "Cheese",
      "Frozen vegetables",
      "Tortillas",
      "Bread",
      "Soy sauce",
      "Hot sauce",
      "Stock or broth",
    ],
  },
  {
    id: "proteins",
    section: "Ingredients",
    prompt: "Which proteins do you eat?",
    kind: "multi",
    promptLabel: "Eats",
    options: [
      "Chicken",
      "Beef",
      "Pork",
      "Turkey",
      "Fish",
      "Shellfish",
      "Eggs",
      "Tofu or tempeh",
      "Beans and lentils",
      "I eat plants only",
    ],
  },
  {
    id: "dislikes",
    section: "Ingredients",
    prompt: "Anything you just do not like?",
    help: "Not an allergy, just a no thank you. We will steer around these.",
    kind: "multi",
    allowOther: true,
    promptLabel: "Dislikes",
    options: [
      "Cilantro",
      "Mushrooms",
      "Olives",
      "Blue cheese",
      "Anchovies",
      "Organ meat",
      "Beets",
      "Eggplant",
      "Tofu",
      "Coconut",
      "Raisins",
      "Bell peppers",
      "Licorice or fennel",
    ],
  },
  {
    id: "diet",
    section: "Ingredients",
    prompt: "Do you follow any particular way of eating?",
    kind: "multi",
    allowOther: true,
    promptLabel: "Diet",
    options: [
      "No restrictions",
      "Vegetarian",
      "Vegan",
      "Pescatarian",
      "Gluten free",
      "Dairy free",
      "Halal",
      "Kosher",
      "Keto or low carb",
      "Low sodium",
      "Diabetic friendly",
      "Paleo or Whole30",
    ],
  },

  // ---- Allergies --------------------------------------------------------
  {
    id: "allergies",
    section: "Allergies and anything else",
    prompt: "Do you have any food allergies or intolerances?",
    help: "Please answer this one even if the answer is no. We treat allergies as a hard rule, never a preference.",
    kind: "multi",
    allowOther: true,
    required: true,
    promptLabel: "ALLERGIES",
    options: [
      "No food allergies",
      "Peanuts",
      "Tree nuts",
      "Milk or dairy",
      "Eggs",
      "Wheat or gluten",
      "Soy",
      "Fish",
      "Shellfish",
      "Sesame",
      "Mustard",
      "Celery",
      "Sulfites",
    ],
  },
  {
    id: "notes",
    section: "Allergies and anything else",
    prompt: "Anything else we should know?",
    help: "Optional. A picky eater at the table, a goal you are working toward, a dish you have been meaning to try.",
    kind: "text",
    promptLabel: "Also",
  },
] as const;

/** The explicit opt-out on the allergies question. */
export const NO_ALLERGIES = "No food allergies";

export function questionsForSection(section: string): Question[] {
  return QUESTIONS.filter((q) => q.section === section);
}

export function questionById(id: string): Question | undefined {
  return QUESTIONS.find((q) => q.id === id);
}

/** Every value the user actually picked, free-text "other" included. */
export function answerValues(answer: Answer | undefined): string[] {
  if (answer === undefined) return [];
  const other = answer.other?.trim();
  return other ? [...answer.choices, other] : [...answer.choices];
}

/** Whether a required question has been answered at all. */
export function isAnswered(question: Question, answer: Answer | undefined): boolean {
  if (question.kind === "text") {
    return (answer?.other ?? "").trim().length > 0;
  }
  return answerValues(answer).length > 0;
}
