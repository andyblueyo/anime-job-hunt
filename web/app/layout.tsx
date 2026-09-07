import type { Metadata } from "next";
import localFont from "next/font/local";
import { Nav } from "@/components/nav";
import "./globals.css";

// All three faces are bundled from app/fonts/ — nothing is fetched from
// Google Fonts at runtime. Source copies live in design/fonts/.

// VCR OSD Mono: single weight (family VCRosdNEUE, subfamily Medium), pixel
// face. Used for every mono/HUD label at whole-pixel sizes; fake bold is
// disabled where it's used (see `.mono` in globals.css).
const vcr = localFont({
  src: "./fonts/VCROSDMono.ttf",
  variable: "--font-vcr",
  weight: "400",
  style: "normal",
  display: "block",
});

// Display headline face.
const archivoBlack = localFont({
  src: "./fonts/ArchivoBlack-Regular.ttf",
  variable: "--font-archivo-black",
  weight: "400",
  style: "normal",
  display: "swap",
});

// Body text; italic for quotes.
const archivo = localFont({
  src: [
    { path: "./fonts/Archivo-Regular.ttf", weight: "400", style: "normal" },
    { path: "./fonts/Archivo-Medium.ttf", weight: "500", style: "normal" },
    { path: "./fonts/Archivo-Bold.ttf", weight: "700", style: "normal" },
    { path: "./fonts/Archivo-Italic.ttf", weight: "400", style: "italic" },
  ],
  variable: "--font-archivo",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Next Ep. Lock",
  description: "Apply to jobs between anime episodes.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${vcr.variable} ${archivoBlack.variable} ${archivo.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        <div className="mx-auto flex w-full max-w-[1140px] flex-1 flex-col gap-3 px-3 pb-20 pt-3 sm:px-5 sm:pt-5">
          <Nav />
          <main className="flex-1">{children}</main>
        </div>
      </body>
    </html>
  );
}
