import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Clearing — event supply console",
  description: "Your event. Supplied. Even when plans change. Demo suppliers · Local rules · Simulated orders.",
  icons: { icon: "/icon.svg" },
};

export const viewport: Viewport = {
  themeColor: "#0b1220",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-dvh bg-ink text-text antialiased">{children}</body>
    </html>
  );
}
