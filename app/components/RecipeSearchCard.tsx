"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import { useSessionToken } from "@/app/lib/session";
import { cardClass, inputClass, primaryButtonClass } from "@/app/lib/formClasses";

/** The pipeline's steps, in order, for the progress list. */
const STEPS = [
  { status: "searching", label: "Searching" },
  { status: "reading", label: "Reading recipes" },
  { status: "shopping", label: "Building your list" },
  { status: "emailing", label: "Sending your email" },
] as const;

const ORDER = ["queued", "searching", "reading", "shopping", "emailing", "done"];

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
    <div className={cardClass}>
      <h2 className="text-xs font-medium uppercase tracking-[0.16em] text-frost">
        What can I make tonight?
      </h2>
      <p className="mt-3 text-sm leading-relaxed text-muted">
        Tell us what you feel like. We&rsquo;ll search real recipes that fit your
        profile, work out what you need to buy, and email you the results.
      </p>

      <form onSubmit={onSubmit} className="mt-5 space-y-3">
        <label htmlFor="recipe-prompt" className="sr-only">
          What do you want to cook?
        </label>
        <input
          id="recipe-prompt"
          type="text"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="something warm with chicken"
          maxLength={280}
          disabled={pending || running}
          className={inputClass}
        />
        {error !== null ? (
          <p role="status" aria-live="polite" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={pending || running || prompt.trim().length < 3}
          className={primaryButtonClass}
        >
          {pending ? "Starting…" : running ? "Searching…" : "Find me recipes"}
        </button>
      </form>

      {job !== undefined && job !== null ? <JobPanel job={job} /> : null}
    </div>
  );
}

type Job = NonNullable<FunctionReturnType<typeof api.recipeJobs.latest>>;

function JobPanel({ job }: { job: Job }) {
  if (job.status === "failed") {
    return (
      <Panel>
        <p role="status" aria-live="polite" className="text-sm text-danger">
          {job.error ?? "That search didn't work out."}
        </p>
        <p className="mt-1 text-xs text-muted">
          Nothing was charged for a search that failed. Try again whenever.
        </p>
      </Panel>
    );
  }

  // A step that crashed leaves the row untouched rather than moving it to
  // failed, so say so plainly instead of spinning forever.
  if (job.stalled) {
    return (
      <Panel>
        <p role="status" aria-live="polite" className="text-sm text-danger">
          This search stopped responding. Start another one when you&rsquo;re ready.
        </p>
      </Panel>
    );
  }

  if (job.status !== "done") {
    const current = ORDER.indexOf(job.status);
    return (
      <Panel>
        <p className="text-xs uppercase tracking-[0.16em] text-frost">
          Searching for &ldquo;{job.prompt}&rdquo;
        </p>
        <ol className="mt-3 space-y-2" aria-live="polite">
          {STEPS.map((step) => {
            const at = ORDER.indexOf(step.status);
            const done = current > at;
            const active = job.status === step.status;
            return (
              <li
                key={step.status}
                className={`flex items-center gap-2 text-sm ${
                  done ? "text-muted" : active ? "text-foreground" : "text-muted/60"
                }`}
              >
                <span aria-hidden className="w-4 text-center">
                  {done ? "✓" : active ? "→" : "·"}
                </span>
                <span>{step.label}</span>
              </li>
            );
          })}
        </ol>
        {job.statusDetail !== undefined ? (
          <p className="mt-3 text-xs text-muted">{job.statusDetail}</p>
        ) : null}
      </Panel>
    );
  }

  return (
    <Panel>
      <p className="text-xs uppercase tracking-[0.16em] text-frost">
        {job.recipes.length} {job.recipes.length === 1 ? "recipe" : "recipes"} for
        &ldquo;{job.prompt}&rdquo;
      </p>

      <ul className="mt-3 space-y-3">
        {job.recipes.map((recipe) => (
          <li key={recipe.url}>
            <a
              href={recipe.url}
              target="_blank"
              rel="noreferrer"
              className="text-sm font-medium text-foreground underline-offset-4 hover:underline"
            >
              {recipe.name}
            </a>
            <p className="mt-0.5 text-xs text-muted">
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

      {job.shopping.length > 0 ? (
        <div className="mt-6">
          <h3 className="text-xs uppercase tracking-[0.16em] text-frost">
            What to shop for
          </h3>
          <p className="mt-1 text-xs text-muted">
            {job.shopping.length} things, already combined across every recipe.
          </p>
          <div className="mt-3 space-y-4">
            {groupByDepartment(job.shopping).map((group) => (
              <div key={group.department}>
                <p className="text-xs font-medium text-muted">{group.department}</p>
                <ul className="mt-1 space-y-1">
                  {group.items.map((item) => {
                    const store = storeNote(item);
                    return (
                      <li key={item.item} className="text-sm">
                        <span className="capitalize">{item.item}</span>
                        {item.usedIn.length > 1 ? (
                          <span className="text-xs text-muted">
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
        </div>
      ) : null}

      {/* An allergen drop is something the user deserves to be told about
          rather than a silent gap in the results. */}
      {job.skipped.length > 0 ? (
        <p className="mt-5 text-xs text-muted">
          We set aside {job.skipped.length}{" "}
          {job.skipped.length === 1 ? "recipe" : "recipes"}:{" "}
          {job.skipped.map((entry) => entry.reason.toLowerCase()).join(", ")}.
        </p>
      ) : null}

      <p className="mt-5 text-xs text-muted">
        {job.emailed
          ? "We emailed this to you too."
          : "You're unsubscribed, so this is on screen only."}
      </p>
    </Panel>
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
      <span className="block text-xs text-muted">
        {store.storeLabel}:{" "}
        <a
          href={store.productUrl}
          target="_blank"
          rel="noreferrer"
          className="text-frost underline-offset-4 hover:underline"
        >
          {store.productTitle}
        </a>
      </span>
    );
  }
  if (store.searchUrl !== undefined) {
    return (
      <span className="block text-xs text-muted">
        <a
          href={store.searchUrl}
          target="_blank"
          rel="noreferrer"
          className="text-frost underline-offset-4 hover:underline"
        >
          Find {item} at {store.storeLabel}
        </a>
      </span>
    );
  }
  return <span className="block text-xs text-muted">Try {store.storeLabel}</span>;
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-6 rounded-2xl border border-border-subtle bg-surface-muted p-5">
      {children}
    </div>
  );
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
