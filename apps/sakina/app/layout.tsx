import type { Metadata, Viewport } from "next";
import { IBM_Plex_Sans_Arabic, Amiri } from "next/font/google";
import { SiteHeader } from "./components/site-shell";
import "./globals.css";

const arabic = IBM_Plex_Sans_Arabic({
  subsets: ["arabic", "latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-arabic",
  display: "swap",
});
const naskh = Amiri({
  subsets: ["arabic", "latin"],
  weight: ["400", "700"],
  variable: "--font-naskh",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "سَكينة — مساحة للبوح والطمأنينة",
    template: "%s | سَكينة",
  },
  description:
    "تحدّث مع سكينة بصوتك. مساحة للمساندة النفسية والروحية، تستمع إليك وتشاركك تلاوات قرآنية بصوت قارئ حقيقي، دون حساب.",
  applicationName: "سَكينة",
  robots: { index: true, follow: true },
  openGraph: {
    title: "سَكينة — مساحة للبوح والطمأنينة",
    description: "تحدّث، خذ وقتك، واستمع إلى تلاوة تطمئنّ إليها.",
    locale: "ar_SA",
    type: "website",
  },
};
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f6f7f2",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="ar"
      dir="rtl"
      className={`${arabic.variable} ${naskh.variable}`}
    >
      <body>
        <a className="skip-link" href="#main">
          انتقل إلى المحتوى
        </a>
        <SiteHeader />
        {children}
      </body>
    </html>
  );
}
