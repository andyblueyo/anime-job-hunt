"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/queue", label: "Queue" },
  { href: "/settings", label: "Settings" },
] as const;

export function Nav() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-10 border-b border-white/10 bg-void/60 backdrop-blur-lg">
      <div className="mx-auto flex w-full max-w-5xl items-center gap-6 px-5 py-4">
        <Link href="/" className="brand shrink-0">
          Next<span className="text-magenta">.</span>Ep<span className="text-magenta">.</span>Lock
        </Link>

        <nav className="flex items-center gap-1">
          {LINKS.map(({ href, label }) => {
            const active = pathname === href;
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                className={`rounded-full px-3.5 py-1.5 text-sm font-bold transition-colors ${
                  active
                    ? "bg-white/12 text-glow"
                    : "text-haze hover:bg-white/6 hover:text-glow"
                }`}
              >
                {label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
