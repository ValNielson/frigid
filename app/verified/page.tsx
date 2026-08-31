import Link from "next/link";

export const metadata = {
  title: "You're on the list · frigid",
};

export default function VerifiedPage() {
  return (
    <div className="relative flex flex-1 flex-col items-center justify-center overflow-hidden px-6 py-16">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 left-1/2 h-[32rem] w-[32rem] -translate-x-1/2 rounded-full bg-frost/20 blur-3xl"
      />

      <main className="relative w-full max-w-md rounded-3xl border border-border-subtle bg-surface p-8 text-center shadow-sm sm:p-10">
        <p className="text-xs font-medium uppercase tracking-[0.28em] text-frost">
          frigid
        </p>
        <h1 className="mt-4 text-3xl font-semibold tracking-tight">
          Recipes are coming
        </h1>
        <p className="mt-4 text-muted">
          Your email is verified. The pantry, the recipe finder, and the
          what-can-I-make-tonight list are still being built &mdash; you&rsquo;ll be the
          first to hear when they land.
        </p>
        <Link
          href="/"
          className="mt-8 inline-block text-sm font-medium text-frost underline-offset-4 hover:underline"
        >
          Back to the start
        </Link>
      </main>
    </div>
  );
}
