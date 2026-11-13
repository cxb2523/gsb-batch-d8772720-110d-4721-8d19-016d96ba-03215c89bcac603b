"use client";

import { BaseStyles, ThemeProvider } from "@primer/react";
import { Toaster } from "sonner";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider colorMode="day">
      <BaseStyles>
        {children}
        <Toaster richColors position="top-right" />
      </BaseStyles>
    </ThemeProvider>
  );
}
