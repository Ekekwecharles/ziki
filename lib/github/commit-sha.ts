/** The shortest commit ID Ziki treats as naming one commit (git's own default abbreviation). */
export const MIN_COMMIT_ID_LENGTH = 7;

const HEX = /^[0-9a-f]+$/i;

/**
 * True when `a` and `b` name the same commit: equal ignoring case, or one is a
 * short form (at least 7 hex characters) of the other. Deliveries and verdicts
 * may send a short ID while reports carry the full one, so a plain `===` would
 * call the same commit "moved".
 */
export function sameCommit(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (x === y) return true;
  if (!HEX.test(x) || !HEX.test(y)) return false;
  const [shorter, longer] = x.length <= y.length ? [x, y] : [y, x];
  return shorter.length >= MIN_COMMIT_ID_LENGTH && longer.startsWith(shorter);
}
