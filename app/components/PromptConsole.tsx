"use client";

import { useRef, useState } from "react";
import { cardClass, primaryButtonClass } from "./ui";

const EXAMPLES = [
  {
    category: "Recipe ideas",
    prompt:
      "I have chicken thighs, rice, and half a lemon — what can I make tonight?",
  },
  {
    category: "Shopping list",
    prompt:
      "Build me a shopping list for five weeknight dinners for two people.",
  },
  {
    category: "Coupons",
    prompt: "Find current coupons and deals for pizza near me.",
  },
];

const MAX_COMPOSER_HEIGHT = 240;

const sendButtonClass =
  "flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-citrus text-xl " +
  "font-semibold text-white transition hover:bg-citrus-strong " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-citrus " +
  "disabled:cursor-not-allowed disabled:opacity-60";

const chipClass =
  "rounded-2xl border border-border-subtle bg-surface-muted px-4 py-3 text-left transition " +
  "hover:border-frost hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 " +
  "focus-visible:outline-frost";

export function PromptConsole() {
  const [prompt, setPrompt] = useState("");
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const sendRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  function resize(element: HTMLTextAreaElement) {
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, MAX_COMPOSER_HEIGHT)}px`;
  }

  function applyExample(text: string) {
    setPrompt(text);
    const composer = composerRef.current;
    if (composer === null) return;
    composer.focus();
    resize(composer);
  }

  function submit() {
    if (prompt.trim() === "") return;
    dialogRef.current?.showModal();
  }

  function reset() {
    setPrompt("");
    const composer = composerRef.current;
    if (composer !== null) composer.style.height = "auto";
    sendRef.current?.focus();
  }

  return (
    <section className="relative w-full">
      <div className="flex items-start gap-3">
        <div
          aria-hidden
          className="animate-orb flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-frost-soft text-base ring-1 ring-frost/30"
        >
          ❄
        </div>
        <div className="rounded-2xl rounded-tl-md border border-border-subtle bg-surface-muted px-4 py-3 text-sm leading-relaxed">
          Ask me one thing about food &mdash; a recipe, a shopping list, a coupon
          worth using. I&rsquo;ll go work on it and email the answer back to you.
        </div>
      </div>

      <div className="mt-8">
        <h2 className="text-xs font-medium uppercase tracking-[0.28em] text-frost">
          Try one of these
        </h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          {EXAMPLES.map((example) => (
            <button
              key={example.category}
              type="button"
              onClick={() => applyExample(example.prompt)}
              className={chipClass}
            >
              <span className="block text-sm font-medium">
                {example.category}
              </span>
              <span className="mt-1 block text-sm leading-snug text-muted">
                {example.prompt}
              </span>
            </button>
          ))}
        </div>
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        className="animate-sheen mt-8 rounded-[1.75rem] bg-[linear-gradient(120deg,var(--frost),var(--citrus),var(--frost))] bg-[length:200%_100%] p-px"
      >
        <div className="rounded-[calc(1.75rem-1px)] bg-surface p-4 transition focus-within:shadow-[0_0_0_4px_var(--frost-soft)]">
          <label htmlFor="prompt" className="sr-only">
            Your question for frigid
          </label>
          <textarea
            id="prompt"
            name="prompt"
            ref={composerRef}
            value={prompt}
            onChange={(event) => {
              setPrompt(event.target.value);
              resize(event.target);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            rows={3}
            placeholder="Ask frigid anything about food…"
            className="w-full resize-none bg-transparent px-1 text-base leading-relaxed text-foreground outline-none placeholder:text-muted/70"
          />

          <div className="mt-2 flex items-end justify-between gap-4">
            <p className="font-mono text-xs text-muted">
              ↵ to send &middot; ⇧↵ for a new line
            </p>
            <button
              type="submit"
              ref={sendRef}
              disabled={prompt.trim() === ""}
              aria-label="Send prompt"
              className={sendButtonClass}
            >
              ↑
            </button>
          </div>
        </div>
      </form>

      <p role="status" aria-live="polite" className="mt-4 text-center text-xs text-muted">
        One question per send. Answers arrive by email, not on this screen.
      </p>

      <dialog
        ref={dialogRef}
        aria-labelledby="sent-heading"
        onClose={reset}
        className="m-auto w-[calc(100%-3rem)] max-w-md bg-transparent p-0 text-foreground backdrop:bg-background/70 backdrop:backdrop-blur-sm"
      >
        <div className={`${cardClass} text-center`}>
          <div
            aria-hidden
            className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-full bg-frost-soft text-2xl"
          >
            ✓
          </div>
          <h2 id="sent-heading" className="text-2xl font-semibold tracking-tight">
            Your results are on the way
          </h2>
          <p className="mt-3 text-muted">
            Results will be sent to your email &mdash; we&rsquo;ll send them over
            as soon as they&rsquo;re ready.
          </p>
          <button
            type="button"
            onClick={() => dialogRef.current?.close()}
            className={`${primaryButtonClass} mt-7`}
          >
            Got it
          </button>
        </div>
      </dialog>
    </section>
  );
}
