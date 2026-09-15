import { Suspense } from "react";
import { OnboardingRoute } from "./OnboardingRoute";

export const metadata = {
  title: "Tell us how you cook · frigid",
};

export default function OnboardingPage() {
  return (
    // useSearchParams needs a Suspense boundary above it.
    <Suspense fallback={null}>
      <OnboardingRoute />
    </Suspense>
  );
}
