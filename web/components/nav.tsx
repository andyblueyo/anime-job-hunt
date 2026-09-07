"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "dashboard" },
  { href: "/queue", label: "queue" },
  // Phase 3: the boards page exists (scraper sources, runs, and what the
  // filter kept out) — this is a real route, not a stub.
  { href: "/boards", label: "boards" },
  { href: "/settings", label: "settings" },
] as const;

const MONTH = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric" });

/**
 * Dark hairline band at the top of every page: brand mark, mono nav, and the
 * month on the right. The dashboard stacks its own dark hero panel under it.
 */
export function Nav() {
  const pathname = usePathname();

  return (
    <header className="card card-dark relative flex flex-wrap items-baseline gap-x-6 gap-y-2.5 px-5 py-4 sm:px-7">
      <Link href="/" className="brand shrink-0">
        next<span className="text-spot">.</span>ep<span className="text-spot">.</span>lock
      </Link>

      <nav className="flex flex-wrap gap-0.5">
        {LINKS.map(({ href, label }) => {
          const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={`mono px-[11px] py-[5px] text-[12px] tracking-[0.12em] no-underline transition-colors ${
                active ? "bg-paper text-ink" : "text-muted-2 hover:text-paper"
              }`}
            >
              {label}
            </Link>
          );
        })}
      </nav>

      <span
        className="mono ml-auto text-[11px] tracking-[0.16em] text-[#8A867E]"
        suppressHydrationWarning
      >
        {MONTH.format(new Date())}
      </span>
    </header>
  );
}
