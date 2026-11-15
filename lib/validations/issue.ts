import { z } from "zod";
import { displayNameSchema } from "@/lib/display-name";
import { BCRYPT_MAX_PASSWORD_BYTES } from "@/lib/password";
import { isGitHubUrl, splitProofLinkLines } from "@/lib/proof-links";
import { stripGitHubMarkup } from "@/lib/github-paste";

export const statuses = ["open", "in_progress", "done", "merge", "resolved", "closed"] as const;

export const statusSchema = z.enum(statuses);

/** The step within a main status (#substatus, lib/issue-substatus.ts). */
export const substatuses = ["requires_confirmation", "open", "plan_review", "in_progress", "requires_review", "accepted", "ready_to_merge", "error", "on_dev", "on_staging", "on_prod", "published", "force_merged", "merged_broken", "closed"] as const;

export const substatusSchema = z.enum(substatuses);

const MAX_PROOF_LINKS = 20;

/**
 * A User.id. Not `.cuid()`: Google sign-in can fall back to `randomUUID()`
 * ids (lib/google-user.ts), and those users must still be assignable (#420).
 * The actions look the user up and reject unknown ids.
 */
const userIdSchema = z.string().trim().min(1).max(191);

/** Optional newline-separated GitHub URLs for issues / PRs. */
export const proofLinksInputSchema = z
  .string()
  .optional()
  .transform((value, ctx) => {
    if (!value?.trim()) return [];

    const rawLines = value.split(/\r?\n/);
    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i]?.trim();
      if (!line) continue;
      if (!isGitHubUrl(line)) {
        ctx.addIssue({
          code: "custom",
          message: `Line ${i + 1} is not a valid GitHub URL: "${line}"`,
        });
        return z.NEVER;
      }
    }

    const rawLinks = splitProofLinkLines(value);
    const links = [...new Set(rawLinks)];
    const count =
      rawLinks.length > links.length && rawLinks.length > MAX_PROOF_LINKS
        ? rawLinks.length
        : links.length;
    if (links.length > MAX_PROOF_LINKS || rawLinks.length > MAX_PROOF_LINKS) {
      ctx.addIssue({
        code: "custom",
        message: `You entered ${count} links. At most ${MAX_PROOF_LINKS} GitHub PR links are allowed.`,
      });
      return z.NEVER;
    }
    return links;
  });

/** Create payload — status is rejected; the server always sets `open`. */
export const createBugSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(3, "Title must be at least 3 characters")
      .max(200, "Title must be at most 200 characters"),
    description: z
      .string()
      .trim()
      .transform((val) => stripGitHubMarkup(val))
      .refine((val) => val.length >= 10, {
        message: "Description must be at least 10 characters",
      })
      .refine((val) => val.length <= 5000, {
        message: "Description cannot exceed 5000 characters",
      }),
    typeId: z.string().optional().nullable().or(z.literal("")),
    assigneeId: userIdSchema.optional().or(z.literal("")),
    areaId: z.string().optional().or(z.literal("")),
    proofLinks: proofLinksInputSchema,
    priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  })
  .strict();

export const updateBugSchema = z.object({
  status: statusSchema.optional(),
  typeId: z.string().nullable().optional().or(z.literal("")),
  assigneeId: userIdSchema.nullable().optional().or(z.literal("")),
  areaId: z.string().nullable().optional().or(z.literal("")),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
});

export const editBugContentSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(3, "Title must be at least 3 characters")
      .max(200, "Title must be at most 200 characters"),
    description: z
      .string()
      .trim()
      .transform((val) => stripGitHubMarkup(val))
      .refine((val) => val.length >= 10, {
        message: "Description must be at least 10 characters",
      })
      .refine((val) => val.length <= 5000, {
        message: "Description cannot exceed 5000 characters",
      }),
  })
  .strict();

/** Replace an issue's proof links after it was filed (#737). Empty clears them. */
export const editProofLinksSchema = z
  .object({
    proofLinks: proofLinksInputSchema,
  })
  .strict();

/** Update or replace a submitted GitHub pull request URL on an issue (#edit-pr-link). */
export const editPullRequestUrlSchema = z
  .object({
    pullRequestUrl: z
      .string()
      .trim()
      .min(1, "Enter a GitHub pull request URL")
      .max(2048, "Pull request URL is too long"),
  })
  .strict();

/**
 * A comment (#entry-replies-only): a plain reply to exactly one stage entry,
 * named by one of the ids below. It has no type, no metadata and no parent.
 */
/** Comments hold detailed investigations, so they can be long. */
export const COMMENT_MAX_CHARS = 10_000;

/** The longest comment label: under 30 characters. */
export const COMMENT_LABEL_MAX_CHARS = 29;
/** A comment's freeform label, e.g. "Blocker" or "Root cause", shown in its title. */
export const commentLabel = z
  .string()
  .trim()
  .min(1, "A label can't be empty")
  .max(COMMENT_LABEL_MAX_CHARS, `A label is under ${COMMENT_LABEL_MAX_CHARS + 1} characters`);

export const commentSchema = z.object({
  body: z
    .string()
    .trim()
    .transform((val) => stripGitHubMarkup(val))
    .refine((val) => val.length >= 1, {
      message: "Comment cannot be empty",
    })
    .refine((val) => val.length <= COMMENT_MAX_CHARS, {
      message: `Comment cannot exceed ${COMMENT_MAX_CHARS.toLocaleString("en-US")} characters`,
    }),
  /** A reply to a confirmation entry (#issue-confirmations) names it here. */
  confirmationId: z
    .string()
    .trim()
    .max(191)
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined)),
  /** A reply to a bid (#issue-bids) names it here. */
  bidId: z
    .string()
    .trim()
    .max(191)
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined)),
  /** A reply to a delivery (#delivered-step) names it here. */
  deliveryId: z
    .string()
    .trim()
    .max(191)
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined)),
  /** A reply to a test verdict (#review-entries) names it here. */
  testVerdictId: z
    .string()
    .trim()
    .max(191)
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined)),
  /** A reply to a merge review (#review-entries) names it here. */
  mergeReviewId: z
    .string()
    .trim()
    .max(191)
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined)),
  /** A reply to a plan (#plan-review) names it here. */
  planId: z
    .string()
    .trim()
    .max(191)
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined)),
  /** A reply to a comment on the issue itself names it here (lib/comment-placement.ts). */
  parentId: z
    .string()
    .trim()
    .max(191)
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined)),
});

const RETEST_OPERATING_SYSTEMS = ["Windows", "macOS", "Linux", "ChromeOS", "iOS", "Android", "Other", "Not sure"] as const;

/** A guided report of a problem that continues after an issue went Live. */
export const retestRequestSchema = z.object({
  operatingSystem: z.enum(RETEST_OPERATING_SYSTEMS, { error: "Choose an operating system or Not sure." }),
  installedVersion: z.string().trim().max(80, "Version must be 80 characters or fewer.").optional().transform((value) => value || "Unknown"),
  currentBehavior: z.string().trim().min(10, "Describe what happens now in at least 10 characters.").max(4000, "Keep the description under 4,000 characters."),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const passwordField = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(128)
  .refine(
    (password) =>
      new TextEncoder().encode(password).length <= BCRYPT_MAX_PASSWORD_BYTES,
    {
      message:
        "Password is too long: bcrypt keeps only the first 72 bytes, so choose something shorter.",
    },
  );

export const signupSchema = z
  .object({
    name: displayNameSchema,
    email: z
      .string()
      .trim()
      .email("Enter a valid email")
      .transform((value) => value.toLowerCase()),
    password: passwordField,
    confirmPassword: z.string().min(1, "Confirm your password"),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

export const forgotPasswordSchema = z.object({
  email: z
    .string()
    .trim()
    .email("Enter a valid email")
    .transform((value) => value.toLowerCase()),
});

export const resetPasswordSchema = z
  .object({
    token: z.string().trim().min(1, "Reset link is invalid or expired"),
    password: passwordField,
    confirmPassword: z.string().min(1, "Confirm your password"),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

/** Credentials required before a signed-in person can change their password. */
export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Enter your current password"),
    password: passwordField,
    confirmPassword: z.string().min(1, "Confirm your new password"),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

/**
 * An EVM wallet address (#618): `0x` followed by 40 hex characters. Shape
 * only — no checksum validation — because the person is the one who chooses
 * where their points would go. Blank clears the address, which is why "" is
 * accepted here and comes out of the transform as `null`.
 */
export const walletAddressSchema = z
  .string()
  .trim()
  .refine((value) => value === "" || /^0x[0-9a-fA-F]{40}$/.test(value), {
    message: "Enter a valid EVM address: 0x followed by 40 hex characters.",
  })
  .transform((value) => (value === "" ? null : value));
