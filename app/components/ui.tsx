export const pageShellClass =
  "relative flex flex-1 flex-col items-center justify-center overflow-hidden px-6 py-16";

export const inputClass =
  "w-full rounded-xl border border-border-subtle bg-surface-muted px-4 py-3 text-base " +
  "text-foreground outline-none transition placeholder:text-muted/70 " +
  "focus:border-frost focus:ring-2 focus:ring-frost/30 disabled:opacity-60";

export const primaryButtonClass =
  "w-full rounded-full bg-citrus px-5 py-3 text-base font-semibold text-white transition " +
  "hover:bg-citrus-strong focus-visible:outline-2 focus-visible:outline-offset-2 " +
  "focus-visible:outline-citrus disabled:cursor-not-allowed disabled:opacity-60";

export const cardClass =
  "rounded-3xl border border-border-subtle bg-surface p-8 shadow-sm sm:p-10";

export function Card({ children }: { children: React.ReactNode }) {
  return <div className={`w-full max-w-md ${cardClass}`}>{children}</div>;
}

export function Feedback({
  error,
  notice,
}: {
  error: string | null;
  notice: string | null;
}) {
  if (error === null && notice === null) return null;
  return (
    <p
      role="status"
      aria-live="polite"
      className={`text-sm ${error !== null ? "text-danger" : "text-frost"}`}
    >
      {error ?? notice}
    </p>
  );
}

export function FrostBloom({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={
        "pointer-events-none absolute -top-40 left-1/2 h-[32rem] w-[32rem] " +
        "-translate-x-1/2 rounded-full bg-frost/20 blur-3xl " +
        className
      }
    />
  );
}
