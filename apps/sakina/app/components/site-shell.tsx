import Link from "next/link";
import { Leaf } from "lucide-react";

export function SiteHeader() {
  return (
    <header className="site-header shell">
      <Link href="/" className="brand" aria-label="سَكينة، الصفحة الرئيسية">
        <Leaf size={24} strokeWidth={1.4} aria-hidden="true" />
        <span>سَكينة</span>
      </Link>
      <span className="brand-tagline">قليل من البوح، مساحة للسكينة</span>
    </header>
  );
}
