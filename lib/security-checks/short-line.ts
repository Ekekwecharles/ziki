/**
 * A finding's description cut to one short line for the page (14 Nov call):
 * Markdown marks dropped, then the first sentence, at most about 140
 * characters. The downloaded report keeps the full text.
 */
export function shortLine(markdown: string, max = 140): string {
  const plain = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const sentence = plain.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? plain;
  if (sentence.length <= max) return sentence;
  const cut = sentence.slice(0, max);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 60 ? cut.lastIndexOf(" ") : max).trimEnd()}…`;
}
