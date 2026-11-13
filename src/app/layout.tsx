import type { Metadata } from "next";
import "@primer/primitives/dist/css/functional/themes/light.css";
import "./globals.css";
import { Providers } from "@/components/providers";

export const metadata: Metadata = {
  title: "Copilot Billing Forecast - Analyze & forecast GitHub Copilot AI usage and spend",
  description:
    "Client-side toolbox for analyzing and forecasting GitHub Copilot AI Credit usage and spend. Your data never leaves the browser.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" data-color-mode="light" data-light-theme="light" suppressHydrationWarning>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
