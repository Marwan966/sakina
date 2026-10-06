import assert from "node:assert/strict";
import test from "node:test";
import { sourcePlainText } from "../apps/sakina/lib/source-text";

test("source extraction preserves Arabic, separates elements and decodes entities once", () => {
  assert.equal(
    sourcePlainText(
      '<p title="a > b">رحمة&nbsp;الله</p><p>صبر &#x648; أمل</p>',
    ),
    "رحمة الله صبر و أمل",
  );
  assert.equal(
    sourcePlainText("&amp;lt; &amp;#39; &lt; &quot;"),
    '&lt; &#39; < "',
  );
});
test("source extraction omits executable, style and comment content with mixed-case tags", () => {
  assert.equal(
    sourcePlainText(
      "<p>المعنى</p><SCRIPT>secret <script>ignored</SCRIPT><STYLE>.hidden {display:none}</STYLE><!-- hidden --><p>الموثق</p>",
    ),
    "المعنى الموثق",
  );
});
test("malformed markup remains inert plain text and does not duplicate decoding", () => {
  assert.equal(sourcePlainText("<p>قبل<script>unterminated"), "قبل");
  assert.equal(sourcePlainText("<b>أ</b><br/>ب &amp;amp;"), "أ ب &amp;");
});
