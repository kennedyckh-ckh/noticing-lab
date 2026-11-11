import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Noticing Lab: video-based teacher PD",
  description: "Notice, discuss and compare what you see in classroom video.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
