"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import { useSessionToken } from "@/app/lib/session";
import { panelClass } from "@/app/lib/formClasses";

/** The pipeline's steps, in order, for the progress list. */
const STEPS = [
  { status: "searching", label: "Searching" },
  { status: "reading", label: "Reading recipes" },
  { status: "shopping", label: "Building your list" },
  { status: "dealing", label: "Checking for deals" },
  { status: "emailing", label: "Sending your email" },
] as const;

const ORDER = [
  "queued",
  "searching",
  "reading",
  "shopping",
  "dealing",
  "emailing",
  "done",
];

/** One-tap starters that fill the composer rather than sending on their own. */
const STARTERS = [
  { label: "Use what's in my fridge", prompt: "something with chicken thighs, rice, and a lemon" },
  { label: "Plan five dinners", prompt: "five weeknight dinners for two" },
  { label: "Something quick", prompt: "a vegetarian dinner in under 30 minutes" },
];

export function RecipeSearchCard() {
  const session = useSessionToken();
  const start = useMutation(api.recipeJobs.start);

  const token = session.status === "ready" ? (session.token ?? undefined) : undefined;
  const args = session.status === "ready" ? { sessionToken: token } : "skip";
  const job = useQuery(api.recipeJobs.latest, args);

  const [prompt, setPrompt] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const running =
    job !== undefined &&
    job !== null &&
    !job.stalled &&
    ORDER.includes(job.status) &&
    job.status !== "done";

  const busy = pending || running;

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (token === undefined) return;

    setPending(true);
    setError(null);
    try {
      const result = await start({ sessionToken: token, prompt });
      if (!result.ok) {
        setError(result.error ?? "We couldn't start that search.");
        return;
      }
      setPrompt("");
    } catch {
      setError("Something went wrong starting that. Try again in a moment.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <form
          onSubmit={onSubmit}
          className="flex flex-col gap-3.5 rounded-[22px] bg-surface px-5 py-[18px] shadow-[0_8px_26px_rgba(85,67,72,0.09)] transition focus-within:shadow-[0_8px_26px_rgba(85,67,72,0.09),0_0_0_3px_var(--mint)]"
        >
          <label htmlFor="recipe-prompt" className="sr-only">
            What do you want to cook?
          </label>
          <input
            id="recipe-prompt"
            type="text"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="something warm with chicken…"
            maxLength={280}
            disabled={busy}
            className="w-full bg-transparent text-lg text-foreground outline-none placeholder:text-subtle disabled:opacity-60"
          />
          <div className="flex items-center justify-between gap-3">
            <div className="flex flex-wrap gap-2">
              {STARTERS.map((starter) => (
                <button
                  key={starter.label}
                  type="button"
                  disabled={busy}
                  onClick={() => setPrompt(starter.prompt)}
                  className="rounded-full bg-surface-muted px-3.5 py-1.5 text-sm transition hover:bg-mint disabled:opacity-50"
                >
                  {starter.label}
                </button>
              ))}
            </div>
            <button
              type="submit"
              disabled={busy || prompt.trim().length < 3}
              aria-label={pending ? "Starting" : running ? "Searching" : "Find me recipes"}
              className="flex h-11 w-11 flex-none items-center justify-center rounded-full bg-action text-lg text-white transition hover:bg-plum focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "…" : "↑"}
            </button>
          </div>
        </form>

        <p role="status" aria-live="polite" className={`text-center text-[13px] ${error !== null ? "text-danger" : "text-muted"}`}>
          {error ??
            "We'll search real recipes that fit your profile, work out what to buy, and email you the results."}
        </p>
      </div>

      {job !== undefined && job !== null ? <JobPanel job={job} /> : null}
    </div>
  );
}

type Job = NonNullable<FunctionReturnType<typeof api.recipeJobs.latest>>;

function JobPanel({ job }: { job: Job }) {
  if (job.status === "failed") {
    return (
      <div className="rounded-[20px] border border-danger/30 bg-surface px-6 py-5">
        <p role="status" aria-live="polite" className="text-[15px] text-danger">
          {job.error ?? "That search didn't work out."}
        </p>
        {job.skipped.length > 0 ? (
          <ul className="mt-3 space-y-1">
            {job.skipped.map((entry) => (
              <li key={entry.url} className="text-sm text-muted">
                {entry.reason} &mdash;{" "}
                <a
                  href={entry.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-action underline-offset-4 hover:underline"
                >
                  {hostOf(entry.url)}
                </a>
              </li>
            ))}
          </ul>
        ) : null}
        <p className="mt-3 text-sm text-muted">
          Try again whenever &mdash; recipes we have already read are cached, so
          another search costs nothing extra.
        </p>
      </div>
    );
  }

  // A step that crashed leaves the row untouched rather than moving it to
  // failed, so say so plainly instead of spinning forever.
  if (job.stalled) {
    return (
      <div className="rounded-[20px] border border-danger/30 bg-surface px-6 py-5">
        <p role="status" aria-live="polite" className="text-[15px] text-danger">
          This search stopped responding. Start another one when you&rsquo;re ready.
        </p>
      </div>
    );
  }

  if (job.status !== "done") {
    const current = ORDER.indexOf(job.status);
    const activeIndex = STEPS.findIndex((step) => step.status === job.status);
    return (
      <div className="flex items-start gap-5 rounded-[20px] border border-teal bg-surface px-[22px] py-5">
        <div aria-hidden className="animate-pulse-ring h-11 w-11 flex-none rounded-full bg-teal" />
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <span className="text-lg font-medium">{job.prompt}</span>
            <span className="text-sm text-muted">
              {activeIndex === -1
                ? "Queued"
                : `${STEPS[activeIndex].label} · ${activeIndex + 1} of ${STEPS.length}`}
            </span>
          </div>
          <div className="flex gap-1.5" aria-hidden>
            {STEPS.map((step) => {
              const at = ORDER.indexOf(step.status);
              return (
                <div
                  key={step.status}
                  className={`h-[7px] flex-1 rounded-full ${
                    current > at
                      ? "bg-action"
                      : job.status === step.status
                        ? "animate-shimmer"
                        : "bg-track"
                  }`}
                />
              );
            })}
          </div>
          <ol className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted" aria-live="polite">
            {STEPS.map((step) => {
              const at = ORDER.indexOf(step.status);
              const done = current > at;
              const active = job.status === step.status;
              return (
                <li
                  key={step.status}
                  className={done || active ? "text-foreground" : undefined}
                >
                  <span className={active ? "font-medium" : undefined}>
                    {done ? "✓ " : active ? "→ " : ""}
                    {step.label}
                  </span>
                </li>
              );
            })}
          </ol>
          <p className="text-sm text-muted">
            {job.statusDetail ??
              "We'll email you the moment it's done. You can close this."}
          </p>
        </div>
      </div>
    );
  }

  const hasList = job.shopping.length > 0;

  return (
    <section className="flex flex-col gap-5">
      <div>
        <h2 className="text-2xl font-semibold tracking-[-0.02em]">
          {job.recipes.length} {job.recipes.length === 1 ? "recipe" : "recipes"} for
          &ldquo;{job.prompt}&rdquo;
        </h2>
        <p className="mt-1.5 text-[15px] text-muted">
          {hasList
            ? `${job.shopping.length} things to buy, already combined across every recipe. `
            : ""}
          {job.emailed
            ? "We emailed this to you too."
            : "You're unsubscribed, so this is on screen only."}
        </p>
      </div>

      <div className={`grid gap-7 ${hasList ? "lg:grid-cols-[1.3fr_1fr]" : ""}`}>
        {hasList ? (
          <div className="flex flex-col gap-5">
            {groupByDepartment(job.shopping).map((group) => (
              <div key={group.department}>
                <h3 className="slab">{group.department}</h3>
                <ul className="mt-2">
                  {group.items.map((item) => {
                    const store = storeNote(item);
                    return (
                      <li
                        key={item.item}
                        className="border-b border-border-subtle/70 py-2.5"
                      >
                        <span className="text-base capitalize">{item.item}</span>
                        {item.usedIn.length > 1 ? (
                          <span className="text-[13px] text-muted">
                            {" "}
                            · in {item.usedIn.length} recipes
                          </span>
                        ) : null}
                        {store !== undefined ? (
                          <StoreLink store={store} item={item.item} />
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        ) : null}

        <div className="flex flex-col gap-3.5">
          <div className={panelClass}>
            <h3 className="slab">Recipes in this list</h3>
            <ul className="mt-3 flex flex-col gap-3">
              {job.recipes.map((recipe) => (
                <li key={recipe.url}>
                  <a
                    href={recipe.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[15px] leading-snug font-medium underline-offset-4 hover:text-action hover:underline"
                  >
                    {recipe.name}
                  </a>
                  <p className="text-[13px] text-muted">
                    {[
                      recipe.totalTimeMinutes !== undefined
                        ? formatTime(recipe.totalTimeMinutes)
                        : null,
                      recipe.servings !== undefined ? `serves ${recipe.servings}` : null,
                      `${recipe.ingredients.length} ingredients`,
                    ]
                      .filter((bit): bit is string => bit !== null)
                      .join(" · ")}
                  </p>
                </li>
              ))}
            </ul>
          </div>

          {job.deals.length > 0 ? (
            <div className={panelClass}>
              <h3 className="slab">On sale for this list</h3>
              <ul className="mt-3 flex flex-col gap-2.5">
                {job.deals.map((deal) => (
                  <li key={`${deal.title}-${deal.merchantName ?? ""}`} className="text-[15px]">
                    <span>{deal.title}</span>
                    {deal.discount !== undefined ? (
                      <span className="ml-2 rounded-full bg-mint px-2.5 py-0.5 text-[13px] font-medium text-action">
                        {deal.discount}
                      </span>
                    ) : null}
                    {deal.merchantName !== undefined ? (
                      <span className="text-[13px] text-muted"> at {deal.merchantName}</span>
                    ) : null}
                    {deal.code !== undefined ? (
                      <span className="block font-mono text-xs text-muted">
                        Code {deal.code}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {/* An allergen drop is something the user deserves to be told about
              rather than a silent gap in the results. */}
          {job.skipped.length > 0 ? (
            <div className="rounded-[18px] bg-plum p-5 text-white">
              <span className="font-mono text-[11px] font-medium tracking-[0.14em] text-mint uppercase">
                Set aside
              </span>
              <p className="mt-2.5 text-sm leading-relaxed">
                We set aside {job.skipped.length}{" "}
                {job.skipped.length === 1 ? "recipe" : "recipes"}:{" "}
                {job.skipped.map((entry) => entry.reason.toLowerCase()).join(", ")}.
              </p>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function StoreLink({
  store,
  item,
}: {
  store: Job["shopping"][number]["stores"][number];
  item: string;
}) {
  if (store.productUrl !== undefined && store.productTitle !== undefined) {
    return (
      <span className="mt-0.5 block text-[13px] text-muted">
        {store.storeLabel}:{" "}
        <a
          href={store.productUrl}
          target="_blank"
          rel="noreferrer"
          className="text-action underline-offset-4 hover:underline"
        >
          {store.productTitle}
        </a>
      </span>
    );
  }
  if (store.searchUrl !== undefined) {
    return (
      <span className="mt-0.5 block text-[13px] text-muted">
        <a
          href={store.searchUrl}
          target="_blank"
          rel="noreferrer"
          className="text-action underline-offset-4 hover:underline"
        >
          Find {item} at {store.storeLabel}
        </a>
      </span>
    );
  }
  return <span className="mt-0.5 block text-[13px] text-muted">Try {store.storeLabel}</span>;
}

/** Bare host, so a skipped recipe is identifiable without a wall of URL. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function formatTime(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}

/** The list arrives already sorted by department, so a single pass groups it. */
function groupByDepartment(shopping: Job["shopping"]) {
  const groups: { department: string; items: Job["shopping"] }[] = [];
  for (const item of shopping) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.department === item.department) last.items.push(item);
    else groups.push({ department: item.department, items: [item] });
  }
  return groups;
}

/** One store line per item: a matched product beats a plain search link. */
function storeNote(item: Job["shopping"][number]) {
  return (
    item.stores.find((store) => store.productUrl !== undefined) ??
    item.stores.find((store) => store.searchUrl !== undefined) ??
    item.stores[0]
  );
}
