import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AppShell } from "@/components/app-shell";
import { getSessionUser } from "@/lib/auth/server";

export const metadata: Metadata = {
  title: "Userbase — baza pracowników i dostępów",
  description: "Wewnętrzna baza pracowników, dostępów i sekretów działu IT.",
  robots: { index: false, follow: false },
  icons: { icon: "/favicon.svg" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0b0d12",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  return (
    <html lang="pl" suppressHydrationWarning>
      <body>
        <AppShell user={user}>{children}</AppShell>
      </body>
    </html>
  );
}
