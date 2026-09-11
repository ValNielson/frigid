import { AuthGate } from "@/app/components/AuthGate";
import { PromptConsole } from "../components/PromptConsole";
import { FrostBloom, pageShellClass } from "../components/ui";

export const metadata = {
  title: "Ask frigid · frigid",
};

export default function PromptPage() {
  return (
    <AuthGate require="onboarded">
      <div className={pageShellClass}>
        <FrostBloom className="animate-drift" />
        <div
          aria-hidden
          className="animate-drift-slow pointer-events-none absolute -bottom-48 left-1/2 h-[28rem] w-[28rem] -translate-x-1/2 rounded-full bg-citrus/15 blur-3xl"
        />
        <div
          aria-hidden
          className="grid-field pointer-events-none absolute inset-0"
        />

        <main className="relative flex w-full max-w-2xl flex-col items-center gap-10">
          <header className="text-center">
            <p className="text-xs font-medium uppercase tracking-[0.28em] text-frost">
              frigid &middot; assistant
            </p>
            <h1 className="mt-4 text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
              What&rsquo;s in the fridge tonight?
            </h1>
            <p className="mx-auto mt-4 max-w-md text-lg leading-relaxed text-muted">
              Ask for a recipe, a shopping list, or a coupon worth using. One
              question, and the answer lands in your inbox.
            </p>
          </header>

          <PromptConsole />
        </main>
      </div>
    </AuthGate>
  );
}
