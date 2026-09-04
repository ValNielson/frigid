import { Suspense } from "react";
import { OnboardingRoute } from "./OnboardingRoute";

export const metadata = {
  title: "Tell us how you cook · frigid",
};

export default function OnboardingPage() {
  return (
    <div className="relative flex flex-1 flex-col items-center px-6 py-14">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 left-1/2 h-[32rem] w-[32rem] -translate-x-1/2 rounded-full bg-frost/20 blur-3xl"
      />

      <main className="relative flex w-full flex-col items-center">
        <header className="mb-10 max-w-2xl text-center">
          <p className="text-xs font-medium uppercase tracking-[0.28em] text-frost">
            frigid
          </p>
          <h1 className="mt-4 text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">
            Tell us how you cook
          </h1>
          <p className="mx-auto mt-4 max-w-md text-lg leading-relaxed text-muted">
            A few questions so every recipe we send actually fits your kitchen,
            your week, and your table. Skip anything that doesn&rsquo;t apply.
          </p>
        </header>

        {/* useSearchParams needs a Suspense boundary above it. */}
        <Suspense fallback={null}>
          <OnboardingRoute />
        </Suspense>
      </main>
    </div>
  );
}
