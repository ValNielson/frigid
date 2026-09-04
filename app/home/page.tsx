import { AuthGate } from "@/app/components/AuthGate";
import { HomeScreen } from "@/app/components/HomeScreen";

export const metadata = {
  title: "Your kitchen · frigid",
};

export default function HomePage() {
  return (
    <AuthGate require="onboarded">
      <HomeScreen />
    </AuthGate>
  );
}
