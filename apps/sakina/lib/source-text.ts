import { Parser } from "htmlparser2";

/** Extract source text, never HTML. Entity references are decoded exactly once.
 * Callers must keep treating the result as plain text, not an HTML fragment. */
export function sourcePlainText(html: string): string {
  const chunks: string[] = [];
  let suppressed = 0;
  const parser = new Parser(
    {
      onopentag(name) {
        if (name === "script" || name === "style") suppressed++;
        if (!suppressed) chunks.push(" ");
      },
      ontext(text) {
        if (!suppressed) chunks.push(text);
      },
      onclosetag(name) {
        if (name === "script" || name === "style")
          suppressed = Math.max(0, suppressed - 1);
        if (!suppressed) chunks.push(" ");
      },
    },
    { decodeEntities: true, xmlMode: false },
  );
  parser.end(html);
  return chunks.join("").replace(/\s+/gu, " ").trim();
}
