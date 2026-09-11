import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Meen Chanda | Fish Market Haggling Simulator",
  description: "A voice-driven Kerala fish market bargaining game.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className="h-full antialiased"
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
