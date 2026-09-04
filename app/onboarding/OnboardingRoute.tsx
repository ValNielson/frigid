"use client";

import { useSearchParams } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { AuthGate } from "@/app/components/AuthGate";
import { OnboardingWizard } from "@/app/components/onboarding/OnboardingWizard";
import { useSessionToken } from "@/app/lib/session";

/**
 * Two entrances to the same quiz.
 *
 * First run: reached automatically after verifying, and an already-onboarded
 * user is bounced to /home so they cannot be asked twice by accident.
 *
 * Editing: reached from /home with ?edit=1, which is what lets an onboarded
 * user back in. Their saved answers are loaded as the starting point, so
 * "update my answers" means editing rather than starting from a blank quiz.
 */
export function OnboardingRoute() {
  const editing = useSearchParams().get("edit") === "1";
  return (
    <AuthGate require={editing ? "verified-any" : "verified"}>
      {editing ? <EditExisting /> : <OnboardingWizard />}
    </AuthGate>
  );
}

function EditExisting() {
  const session = useSessionToken();
  const prefs = useQuery(
    api.preferences.getMine,
    session.status === "ready"
      ? { sessionToken: session.token ?? undefined }
      : "skip",
  );

  // Wait for the saved answers before mounting the wizard, so it does not
  // briefly show an empty quiz and overwrite the draft with blanks.
  if (prefs === undefined) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 py-16">
        <div
          className="h-8 w-8 animate-spin rounded-full border-2 border-border-subtle border-t-frost"
          role="status"
          aria-label="Loading your answers"
        />
      </div>
    );
  }

  return <OnboardingWizard initialAnswers={prefs?.answers ?? {}} />;
}
