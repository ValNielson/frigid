"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useAction, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { clearSessionToken, useSessionToken } from "@/app/lib/session";
import { Logo } from "./ui";

const NAV = [
  { href: "/home", label: "Kitchen" },
  { href: "/prompt", label: "Ask" },
  { href: "/onboarding?edit=1", label: "Preferences" },
];

/**
 * Top bar for signed-in screens. `nav` off is the onboarding variant: logo and
 * email only, since there is nowhere to go until the quiz is done.
 */
export function AppHeader({ nav = true }: { nav?: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const session = useSessionToken();
  const signOut = useAction(api.verification.signOut);
  const me = useQuery(
    api.me.me,
    session.status === "ready" ? { sessionToken: session.token ?? undefined } : "skip",
  );

  async function onSignOut() {
    const current = session.status === "ready" ? session.token : null;
    // Clear locally first: even if the revoke call fails, this device is out.
    clearSessionToken();
    if (current !== null) {
      try {
        await signOut({ sessionToken: current });
      } catch {
        // The token still expires on its own.
      }
    }
    router.replace("/");
  }

  const email = me?.email;

  return (
    <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-border-subtle/70 px-4 py-2.5 sm:px-10">
      <div className="flex flex-wrap items-center gap-x-8 gap-y-1">
        <Link href={nav ? "/home" : "/"} aria-label="frigid home">
          <Logo />
        </Link>
        {nav ? (
          <nav className="flex items-center gap-5">
            {NAV.map((item) => {
              const active = pathname === item.href.split("?")[0];
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={
                    active
                      ? "border-b-2 border-action pb-0.5 text-[15px] font-medium text-foreground"
                      : "pb-0.5 text-[15px] text-muted transition hover:text-foreground"
                  }
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        ) : null}
      </div>

      <div className="flex items-center gap-3">
        {email !== undefined ? (
          nav ? (
            <span className="flex items-center gap-2 rounded-full border border-border-subtle py-1 pr-3 pl-1">
              <span
                aria-hidden
                className="flex h-7 w-7 items-center justify-center rounded-full bg-teal text-xs font-semibold text-white uppercase"
              >
                {email.charAt(0)}
              </span>
              <span className="max-w-[14rem] truncate text-sm">{email}</span>
            </span>
          ) : (
            <span className="text-sm text-muted">{email}</span>
          )
        ) : null}
        {nav ? (
          <button
            type="button"
            onClick={onSignOut}
            className="text-sm text-muted underline-offset-4 transition hover:text-foreground hover:underline"
          >
            Sign out
          </button>
        ) : null}
      </div>
    </header>
  );
}
