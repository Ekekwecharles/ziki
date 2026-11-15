/**
 * Request-to-join rules shared by the server action and its tests (#join-requests). Kept out of
 * app/actions/project-join-requests.ts, because a "use server" file may export only async functions.
 */

/** How long someone whose request was declined waits before asking the same project again. */
export const DECLINED_REQUEST_COOLDOWN_MS = 24 * 60 * 60 * 1000;
