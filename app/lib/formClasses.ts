/**
 * The class strings every form control in the app shares.
 *
 * Pulled out of VerifyEmailCard once a second form needed them. One source
 * beats two copies that drift the first time someone adjusts a focus ring.
 */

export const inputClass =
  "w-full rounded-xl border border-border-subtle bg-surface-muted px-4 py-3 text-base " +
  "text-foreground outline-none transition placeholder:text-muted/70 " +
  "focus:border-frost focus:ring-2 focus:ring-frost/30 disabled:opacity-60";

export const primaryButtonClass =
  "w-full rounded-full bg-citrus px-5 py-3 text-base font-semibold text-white transition " +
  "hover:bg-citrus-strong focus-visible:outline-2 focus-visible:outline-offset-2 " +
  "focus-visible:outline-citrus disabled:cursor-not-allowed disabled:opacity-60";

export const cardClass =
  "rounded-3xl border border-border-subtle bg-surface p-7 shadow-sm";
