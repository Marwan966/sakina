import Link from "next/link";
import { ArrowLeft, Compass } from "lucide-react";

export default function NotFound() {
  return (
    <main id="main" className="not-found shell">
      <Compass size={45} strokeWidth={1.2} />
      <h1>ربما ضلّ الرابط طريقه.</h1>
      <p>هذه الصفحة غير موجودة. يمكنك العودة إلى مساحتك والبدء من جديد.</p>
      <Link href="/" className="primary-button">
        العودة إلى سَكينة
        <ArrowLeft size={17} />
      </Link>
    </main>
  );
}
