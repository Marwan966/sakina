"use client";
import { RefreshCw, Sprout } from "lucide-react";

export default function ErrorPage({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main id="main" className="not-found shell">
      <Sprout size={45} strokeWidth={1.2} />
      <h1>تعذّر تحميل هذه المساحة.</h1>
      <p>حدث خطأ مؤقت. حاول مرة أخرى لنكمل من هنا.</p>
      <button className="primary-button" onClick={reset}>
        إعادة المحاولة
        <RefreshCw size={17} />
      </button>
    </main>
  );
}
