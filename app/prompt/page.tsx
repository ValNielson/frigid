import { AuthGate } from "@/app/components/AuthGate";
import { AppHeader } from "@/app/components/AppHeader";
import { PromptConsole } from "../components/PromptConsole";

export const metadata = {
  title: "Ask frigid · frigid",
};

export default function PromptPage() {
  return (
    <AuthGate require="onboarded">
      <div className="flex flex-1 flex-col">
        <AppHeader />
        <main className="mint-wash flex-1">
          <div className="mx-auto flex w-full max-w-[860px] flex-col gap-8 px-4 pt-12 pb-16 sm:px-10">
            <header className="flex flex-col gap-3">
              <h1 className="text-3xl font-semibold tracking-[-0.025em] sm:text-[38px]">
                What&rsquo;s in the fridge tonight?
              </h1>
              <p className="max-w-[520px] text-[17px] leading-relaxed text-muted">
                Ask for a recipe, a shopping list, or a coupon worth using. One
                question, and the answer lands in your inbox.
              </p>
            </header>

            <PromptConsole />
          </div>
        </main>
      </div>
    </AuthGate>
  );
}
