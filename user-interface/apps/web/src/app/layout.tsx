import type { Metadata } from "next";

import "../index.css";
import Providers from "@/components/providers";

export const metadata: Metadata = {
  title: "Moon Walk",
  description: "Mobile behavior tracking for connected assistive walking devices.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="th" suppressHydrationWarning>
      <body className="font-line-seed-th antialiased" suppressHydrationWarning>
        <Providers>
          <div className="h-svh">{children}</div>
        </Providers>
      </body>
    </html>
  );
}
