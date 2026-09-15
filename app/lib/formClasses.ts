/**
 * The class strings every form control in the app shares.
 *
 * Pulled out of VerifyEmailCard once a second form needed them. One source
 * beats two copies that drift the first time someone adjusts a focus ring.
 */

export const inputClass =
  "w-full rounded-2xl border border-border-subtle bg-background px-4 py-3 text-base " +
  "text-foreground outline-none transition placeholder:text-subtle " +
  "focus:border-action focus:ring-2 focus:ring-action/20 disabled:opacity-60";

const buttonBase =
  "rounded-full px-6 py-3 text-base transition focus-visible:outline-2 " +
  "focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

/** Deep teal pill. Content-width; add `w-full` where the design stretches it. */
export const primaryButtonClass =
  `${buttonBase} bg-action font-semibold text-white hover:bg-plum ` +
  "focus-visible:outline-action";

export const secondaryButtonClass =
  `${buttonBase} border border-border-subtle font-medium text-muted ` +
  "hover:border-action hover:text-foreground focus-visible:outline-action";

export const linkClass =
  "font-medium text-action underline-offset-4 transition hover:text-plum hover:underline";

/** White panel with the soft plum shadow. */
export const cardClass =
  "rounded-[22px] bg-surface p-8 shadow-[0_6px_24px_rgba(85,67,72,0.08)]";

/** Quieter bordered panel for secondary blocks. */
export const panelClass = "rounded-[18px] border border-border-subtle bg-surface p-6";
