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

/**
 * The first sentence of a text, for the finished check's summary (17 Nov, Hamzat: "1 sentence is okay"). A full
 * stop inside a name ("start.ng") isn't an end: a sentence ends at . ! or ? followed by a space and a capital.
 */
export function firstSentence(text: string): string {
  const trimmed = text.trim();
  const end = trimmed.search(/[.!?](?=\s+[A-Z])/);
  return end === -1 ? trimmed : trimmed.slice(0, end + 1);
}
