import { AuthGate } from "./components/AuthGate";
import { VerifyEmailCard } from "./components/VerifyEmailCard";

export default function Home() {
  return (
    <AuthGate require="anon">
      <div className="relative flex flex-1 flex-col items-center justify-center overflow-hidden px-6 py-16">
        {/* Frost bloom behind the card. */}
        <div
          aria-hidden
          className="pointer-events-none absolute -top-40 left-1/2 h-[32rem] w-[32rem] -translate-x-1/2 rounded-full bg-frost/20 blur-3xl"
        />

        <main className="relative flex w-full max-w-md flex-col items-center gap-10">
          <header className="text-center">
            <p className="text-xs font-medium uppercase tracking-[0.28em] text-frost">
              frigid
            </p>
            <h1 className="mt-4 text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
              Everything in your fridge,
              <br />
              worth cooking.
            </h1>
            <p className="mx-auto mt-4 max-w-sm text-lg leading-relaxed text-muted">
              One place for the ingredients you have and the recipes they add up
              to.
            </p>
          </header>

          <VerifyEmailCard />
        </main>
      </div>
    </AuthGate>
  );
}
