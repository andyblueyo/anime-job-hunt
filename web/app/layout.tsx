import type { Metadata } from "next";
import { Press_Start_2P } from "next/font/google";
import { Nav } from "@/components/nav";
import "./globals.css";

// Pixel font, used only for small HUD-style labels (see `.eyebrow` / `.badge`).
const pressStart = Press_Start_2P({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-press-start",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Next Ep. Lock",
  description: "Apply to jobs between anime episodes.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${pressStart.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <Nav />
        <main className="mx-auto w-full max-w-5xl flex-1 px-5 pb-20 pt-8">{children}</main>
      </body>
    </html>
  );
}
