import { AuthGate } from "@/app/components/AuthGate";

export const metadata = {
  title: "Verified · frigid",
};

/**
 * Kept only so links from earlier verification emails do not dead-end.
 *
 * There is nothing left to show here: verifying now signs you in, and the gate
 * forwards to /onboarding or /home depending on how far you got. A signed-out
 * visitor lands back on the verify card. The "onboarded" requirement can never
 * be satisfied by someone who has not onboarded, so everyone gets redirected.
 */
export default function VerifiedPage() {
  return <AuthGate require="onboarded">{null}</AuthGate>;
}
