"use client";

import { useRef, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useSessionToken } from "@/app/lib/session";
import { DealsRunCard, isRunning, useLatestRun } from "./DealsRunCard";

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
  "flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-action text-lg " +
  "text-white transition hover:bg-plum " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action " +
  "disabled:cursor-not-allowed disabled:opacity-50";

const chipClass =
  "rounded-full bg-surface-muted px-3.5 py-1.5 text-sm transition hover:bg-mint " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action";

export function PromptConsole() {
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const sendRef = useRef<HTMLButtonElement>(null);
  const session = useSessionToken();
  const requestRun = useMutation(api.deals.requestRun);
  const run = useLatestRun();
  const busy = sending || isRunning(run);

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

  async function submit() {
    const text = prompt.trim();
    if (text === "" || busy) return;
    if (session.status !== "ready" || session.token === null) {
      setError("Please verify your email again.");
      return;
    }

    setSending(true);
    setError(null);
    try {
      const result = await requestRun({
        sessionToken: session.token,
        prompt: text,
      });
      if (!result.ok) {
        setError(result.error ?? "Something went wrong. Try again.");
        return;
      }
      reset();
    } catch {
      setError("We could not reach frigid. Check your connection and retry.");
    } finally {
      setSending(false);
    }
  }

  function reset() {
    setPrompt("");
    setError(null);
    const composer = composerRef.current;
    if (composer !== null) composer.style.height = "auto";
    sendRef.current?.focus();
  }

  return (
    <section className="flex w-full flex-col gap-3">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        className="flex flex-col gap-3.5 rounded-[22px] bg-surface px-5 py-[18px] shadow-[0_8px_26px_rgba(85,67,72,0.09)] transition focus-within:shadow-[0_8px_26px_rgba(85,67,72,0.09),0_0_0_3px_var(--mint)]"
      >
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
          className="w-full resize-none bg-transparent text-lg leading-relaxed text-foreground outline-none placeholder:text-subtle"
        />

        <div className="flex items-center justify-between gap-3">
          <div className="flex flex-wrap gap-2">
            {EXAMPLES.map((example) => (
              <button
                key={example.category}
                type="button"
                title={example.prompt}
                onClick={() => applyExample(example.prompt)}
                className={chipClass}
              >
                {example.category}
              </button>
            ))}
          </div>
          <button
            type="submit"
            ref={sendRef}
            disabled={prompt.trim() === "" || busy}
            aria-label={busy ? "Sending prompt" : "Send prompt"}
            className={sendButtonClass}
          >
            {busy ? "…" : "↑"}
          </button>
        </div>
      </form>

      <p
        role="status"
        aria-live="polite"
        className={`text-center text-[13px] ${error !== null ? "text-danger" : "text-muted"}`}
      >
        {error ?? "One question per send. The answer also arrives by email."}
      </p>
      <p className="text-center font-mono text-xs text-subtle">
        ↵ to send &middot; ⇧↵ for a new line
      </p>

      <DealsRunCard />
    </section>
  );
}
