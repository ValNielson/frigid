import { AuthGate } from "./components/AuthGate";
import { VerifyEmailCard } from "./components/VerifyEmailCard";
import { Logo } from "./components/ui";

const HOW_IT_WORKS = [
  {
    step: "01 — Ask",
    title: "One question at a time",
    body: "A recipe, a shopping list, a coupon worth using. Plain language, no filters to set.",
  },
  {
    step: "02 — We work",
    title: "Real recipes, read properly",
    body: "We search, read and check each one against your allergies before it counts.",
  },
  {
    step: "03 — Inbox",
    title: "The answer arrives by email",
    body: "Recipes, one combined shopping list by department, and any deals near you.",
  },
];

export default function Home() {
  return (
    <AuthGate require="anon">
      <div className="flex flex-1 flex-col">
        <header className="flex items-center justify-between gap-4 px-4 py-3.5 sm:px-10">
          <Logo height={58} />
          <nav className="flex items-center gap-6">
            <a
              href="#how-it-works"
              className="hidden text-[15px] text-muted transition hover:text-foreground sm:inline"
            >
              How it works
            </a>
            <a
              href="#get-started"
              className="rounded-full bg-plum px-[18px] py-2 text-[15px] font-medium text-white transition hover:bg-action"
            >
              Get started
            </a>
          </nav>
        </header>

        <main className="flex-1">
          <section className="mint-wash grid items-center gap-12 px-4 pt-12 pb-16 sm:px-10 lg:grid-cols-[1.05fr_.95fr] lg:gap-14">
            <div className="flex flex-col gap-5">
              <span className="self-start rounded-full bg-surface px-3.5 py-1.5 text-[13px] font-medium text-action">
                No app, no account, no password
              </span>
              <h1 className="text-4xl leading-[1.05] font-semibold tracking-[-0.03em] text-pretty sm:text-[58px]">
                Everything in your fridge, worth cooking.
              </h1>
              <p className="max-w-[480px] text-lg leading-relaxed sm:text-[19px]">
                Ask one question about food. frigid reads real recipes, works out
                what you&rsquo;d have to buy, finds what&rsquo;s on sale &mdash; then
                emails you the answer.
              </p>
            </div>

            <div id="get-started" className="flex scroll-mt-6 justify-center lg:justify-end">
              <VerifyEmailCard />
            </div>
          </section>

          <section
            id="how-it-works"
            className="grid scroll-mt-6 gap-7 px-4 pt-12 pb-14 sm:px-10 md:grid-cols-3"
          >
            {HOW_IT_WORKS.map((item) => (
              <div key={item.step} className="flex flex-col gap-2.5">
                <span className="slab">{item.step}</span>
                <h2 className="text-xl font-medium">{item.title}</h2>
                <p className="text-[15px] leading-relaxed text-muted">{item.body}</p>
              </div>
            ))}
          </section>
        </main>
      </div>
    </AuthGate>
  );
}
