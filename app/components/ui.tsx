import Image from "next/image";
import Link from "next/link";

export {
  cardClass,
  inputClass,
  linkClass,
  panelClass,
  primaryButtonClass,
  secondaryButtonClass,
} from "@/app/lib/formClasses";

export function Logo({ height = 52 }: { height?: number }) {
  return (
    <Image
      src="/frigid-logo.png"
      alt="frigid"
      width={1098}
      height={920}
      style={{ height, width: "auto" }}
      preload
    />
  );
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
      className={`text-sm ${error !== null ? "text-danger" : "text-action"}`}
    >
      {error ?? notice}
    </p>
  );
}

/**
 * The allergy callout: plum block, mint badge. Allergies are the one rule we
 * never bend, so they get the heaviest treatment on the page.
 */
export function AllergyNotice({
  title,
  children,
  action,
}: {
  title: string;
  children: React.ReactNode;
  action?: { href: string; label: string };
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl bg-plum px-5 py-4 text-white">
      <div className="flex items-start gap-3.5">
        <span
          aria-hidden
          className="flex h-[26px] w-[26px] flex-none items-center justify-center rounded-full bg-mint text-[15px] font-semibold text-plum"
        >
          !
        </span>
        <div className="text-[15px] leading-relaxed">
          <span className="font-semibold">{title}</span> {children}
        </div>
      </div>
      {action !== undefined ? (
        <Link
          href={action.href}
          className="rounded-full bg-mint px-4 py-2 text-sm font-medium whitespace-nowrap text-plum"
        >
          {action.label}
        </Link>
      ) : null}
    </div>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <div className="flex flex-1 items-center justify-center px-6 py-16">
      <div
        className="h-8 w-8 animate-spin rounded-full border-2 border-track border-t-action"
        role="status"
        aria-label={label}
      />
    </div>
  );
}
