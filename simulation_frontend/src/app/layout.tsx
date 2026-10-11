import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Routz · Columbia railroad simulation",
  description: "An interactive 3D simulation of the railroad network around Columbia, South Carolina.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
