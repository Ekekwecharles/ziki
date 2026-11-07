import { createHmac, randomBytes } from "node:crypto";
import { compare } from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { consumeAuthRateLimit, consumeRateLimit } from "@/lib/rate-limit";
import { openSecret, sealSecret } from "@/lib/secret-box";
import { generateTotpSecret, looksLikeTotpCode, matchTotp, otpauthUri } from "@/lib/totp";

/**
 * TOTP second factor for password accounts (#648). The secret is sealed at
 * rest, a code works once, backup codes are single-use and stored only as
 * keyed hashes, and every change is written to SecurityAuditEvent.
 */

export const BACKUP_CODE_COUNT = 10;
/** Wrong guesses at a code, per person: 6 digits is small, so keep this tight. */
export const TWO_FACTOR_ATTEMPT_LIMIT = { max: 10, windowMs: 15 * 60 * 1000 } as const;

export type SecurityEventType =
  | "totp.enabled"
  | "totp.disabled"
  | "totp.backup_codes_regenerated"
  | "totp.backup_code_used";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Ten characters from an alphabet without look-alikes, shown as XXXXX-XXXXX (about 50 bits). */
export function generateBackupCode(): string {
  const bytes = randomBytes(10);
  let code = "";
  for (const byte of bytes) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/** Case, dashes and spaces do not matter when a code is typed back. */
export function normalizeBackupCode(input: string): string {
  return input.replace(/[\s-]/g, "").toUpperCase();
}

function hashingKey(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 16) throw new Error("AUTH_SECRET must be set to use two-factor sign-in.");
  return `ziki-backup-code:${secret}`;
}

/** Keyed, so a leaked table alone cannot be brute-forced offline. */
export function hashBackupCode(userId: string, code: string): string {
  return createHmac("sha256", hashingKey()).update(`${userId}:${normalizeBackupCode(code)}`).digest("hex");
}

async function record(userId: string, type: SecurityEventType, db: Pick<typeof prisma, "securityAuditEvent"> = prisma) {
  await db.securityAuditEvent.create({ data: { userId, type } });
}

export type TwoFactorStatus = { enabled: boolean; backupCodesLeft: number };

export async function twoFactorStatus(userId: string): Promise<TwoFactorStatus> {
  const credential = await prisma.totpCredential.findUnique({ where: { userId }, select: { enabledAt: true } });
  if (!credential?.enabledAt) return { enabled: false, backupCodesLeft: 0 };
  const backupCodesLeft = await prisma.totpBackupCode.count({ where: { userId, usedAt: null } });
  return { enabled: true, backupCodesLeft };
}

/** Does signing in as this person need a second step? */
export async function isTwoFactorEnabled(userId: string): Promise<boolean> {
  const credential = await prisma.totpCredential.findUnique({ where: { userId }, select: { enabledAt: true } });
  return Boolean(credential?.enabledAt);
}

export type StartResult =
  | { ok: true; secret: string; uri: string }
  | { ok: false; error: string };

/** Makes (or replaces) a pending secret. Nothing asks for a code until it is confirmed. */
export async function startEnrolment(userId: string, account: string): Promise<StartResult> {
  if (await isTwoFactorEnabled(userId)) {
    return { ok: false, error: "Two-factor sign-in is already on. Turn it off first to set it up again." };
  }
  const secret = generateTotpSecret();
  const sealed = sealSecret(secret);
  await prisma.totpCredential.upsert({
    where: { userId },
    create: { userId, secret: sealed },
    update: { secret: sealed, enabledAt: null, lastUsedStep: null },
  });
  return { ok: true, secret, uri: otpauthUri(account, secret) };
}

/** `sessionVersion` is the person's new version: every session made before the change is signed out (Ziki #389). */
export type BackupCodesResult = { ok: true; codes: string[]; sessionVersion: number } | { ok: false; error: string };

/**
 * Bumps User.sessionVersion so every JWT issued before this change stops
 * working, the same way a password reset does. Turning the factor on often
 * means the password leaked, and a session someone else holds must not
 * outlive it (Ziki #389).
 */
async function signOutEverySession(tx: Pick<typeof prisma, "user">, userId: string): Promise<number> {
  const user = await tx.user.update({
    where: { id: userId },
    data: { sessionVersion: { increment: 1 } },
    select: { sessionVersion: true },
  });
  return user.sessionVersion;
}

async function replaceBackupCodes(tx: Pick<typeof prisma, "totpBackupCode">, userId: string): Promise<string[]> {
  const codes = Array.from({ length: BACKUP_CODE_COUNT }, generateBackupCode);
  await tx.totpBackupCode.deleteMany({ where: { userId } });
  await tx.totpBackupCode.createMany({
    data: codes.map((code) => ({ userId, codeHash: hashBackupCode(userId, code) })),
  });
  return codes;
}

/** Checks the first code from the app, turns the factor on and returns the backup codes (once). */
export async function confirmEnrolment(userId: string, input: string, nowMs = Date.now()): Promise<BackupCodesResult> {
  const limit = await consumeRateLimit(`2fa:${userId}`, TWO_FACTOR_ATTEMPT_LIMIT, nowMs);
  if (!limit.allowed) return { ok: false, error: "Too many attempts. Wait a few minutes and try again." };

  const credential = await prisma.totpCredential.findUnique({ where: { userId } });
  if (!credential || credential.enabledAt) {
    return { ok: false, error: "Start setup again to get a new QR code." };
  }
  const step = matchTotp(openSecret(credential.secret), input, { nowMs });
  if (step === null) return { ok: false, error: "That code isn't right. Check your authenticator app and try again." };

  return prisma.$transaction(async (tx) => {
    await tx.totpCredential.update({
      where: { userId },
      data: { enabledAt: new Date(nowMs), lastUsedStep: step },
    });
    const codes = await replaceBackupCodes(tx, userId);
    const sessionVersion = await signOutEverySession(tx, userId);
    await record(userId, "totp.enabled", tx);
    return { ok: true as const, codes, sessionVersion };
  });
}

export type SecondFactorKind = "totp" | "backup";

/**
 * Checks a code typed at sign-in or re-authentication: a six-digit
 * authenticator code (each accepted once) or a backup code (spent on use).
 */
export async function verifySecondFactor(
  userId: string,
  input: string,
  nowMs = Date.now(),
): Promise<SecondFactorKind | null> {
  const limit = await consumeRateLimit(`2fa:${userId}`, TWO_FACTOR_ATTEMPT_LIMIT, nowMs);
  if (!limit.allowed) return null;

  const credential = await prisma.totpCredential.findUnique({ where: { userId } });
  if (!credential?.enabledAt) return null;

  if (looksLikeTotpCode(input)) {
    const step = matchTotp(openSecret(credential.secret), input, { nowMs, afterStep: credential.lastUsedStep });
    if (step === null) return null;
    // Atomic: of two requests carrying the same code, only one moves the step forward.
    const claimed = await prisma.totpCredential.updateMany({
      where: { userId, OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: step } }] },
      data: { lastUsedStep: step },
    });
    return claimed.count === 1 ? "totp" : null;
  }

  if (normalizeBackupCode(input).length !== 10) return null;
  const spent = await prisma.totpBackupCode.updateMany({
    where: { userId, codeHash: hashBackupCode(userId, input), usedAt: null },
    data: { usedAt: new Date(nowMs) },
  });
  if (spent.count !== 1) return null;
  await record(userId, "totp.backup_code_used");
  return "backup";
}

export type ConfirmIdentityResult = { ok: true } | { ok: false; error: string };

/** What `confirmIdentity` answers for a wrong password (a form can word it for its own field). */
export const WRONG_PASSWORD_MESSAGE = "That password isn't right.";

/**
 * Fresh re-authentication for a security change: the password, and the
 * current code when two-factor is on. Checked inside the change itself, never
 * remembered from the session.
 */
export async function confirmIdentity(
  userId: string,
  { password, code }: { password: string; code?: string },
): Promise<ConfirmIdentityResult> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, passwordHash: true } });
  if (!user?.passwordHash) return { ok: false, error: "This account has no password to confirm." };

  const limit = await consumeAuthRateLimit("login", { email: user.email });
  if (!limit.allowed) return { ok: false, error: "Too many attempts. Wait a few minutes and try again." };
  if (!password || !(await compare(password, user.passwordHash))) {
    return { ok: false, error: WRONG_PASSWORD_MESSAGE };
  }

  if (await isTwoFactorEnabled(userId)) {
    if (!code?.trim()) return { ok: false, error: "Enter a code from your authenticator app or a backup code." };
    if (!(await verifySecondFactor(userId, code))) return { ok: false, error: "That code isn't right." };
  }
  return { ok: true };
}

/**
 * Turns the factor off and returns the new session version. The caller must
 * already have re-authenticated (confirmIdentity).
 */
export async function disableTwoFactor(userId: string): Promise<number> {
  return prisma.$transaction(async (tx) => {
    await tx.totpBackupCode.deleteMany({ where: { userId } });
    await tx.totpCredential.deleteMany({ where: { userId } });
    const sessionVersion = await signOutEverySession(tx, userId);
    await record(userId, "totp.disabled", tx);
    return sessionVersion;
  });
}

/**
 * When Google sign-in removes an unproven password (#736), any two-factor set
 * up for that password goes with it (#388): a TOTP secret or backup codes left
 * on a passwordless account can never be used, and an enrolled factor would
 * make Google refuse the account from then on. Writes `totp.disabled` only
 * when something was removed. Returns whether it did.
 *
 * Pass the transaction that removes the password, so the two happen together
 * or not at all: a failure must never leave a passwordless account whose
 * enrolled factor nobody can turn off.
 */
export async function clearTwoFactorAfterPasswordRemoved(
  userId: string,
  tx?: Pick<typeof prisma, "totpBackupCode" | "totpCredential" | "securityAuditEvent">,
): Promise<boolean> {
  const clear = async (db: Pick<typeof prisma, "totpBackupCode" | "totpCredential" | "securityAuditEvent">) => {
    const codes = await db.totpBackupCode.deleteMany({ where: { userId } });
    const credential = await db.totpCredential.deleteMany({ where: { userId } });
    if (codes.count === 0 && credential.count === 0) return false;
    await record(userId, "totp.disabled", db);
    return true;
  };
  return tx ? clear(tx) : prisma.$transaction(clear);
}

export async function regenerateBackupCodes(userId: string): Promise<BackupCodesResult> {
  if (!(await isTwoFactorEnabled(userId))) return { ok: false, error: "Two-factor sign-in is off." };
  return prisma.$transaction(async (tx) => {
    const codes = await replaceBackupCodes(tx, userId);
    const sessionVersion = await signOutEverySession(tx, userId);
    await record(userId, "totp.backup_codes_regenerated", tx);
    return { ok: true as const, codes, sessionVersion };
  });
}
