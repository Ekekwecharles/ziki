import { z } from "zod";

/**
 * Pull request preview settings (#previews) for a project's main repository.
 *
 * The folder and Node version rules match the preview builder's own input
 * checks (zedu-vulcan/ziki-preview-builder), so a setting Ziki accepts is one
 * the builder runs.
 */

export type BuildVariables = Record<string, string>;

export type PreviewSettingsValues = {
  enabled: boolean;
  rootDir: string;
  /** Null: detected from the lock file. */
  installCommand: string | null;
  buildCommand: string;
  outputDir: string;
  nodeVersion: string;
  buildVariables: BuildVariables;
};

export const DEFAULT_PREVIEW_SETTINGS: PreviewSettingsValues = {
  enabled: false,
  rootDir: ".",
  installCommand: null,
  buildCommand: "npm run build",
  outputDir: "dist",
  nodeVersion: "22",
  buildVariables: {},
};

export const MAX_BUILD_VARIABLES = 30;
const NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
/** Names the builder's runner owns; the builder refuses them too. */
const RESERVED_NAME = /^(?:GITHUB_|RUNNER_|ACTIONS_)|^(?:PATH|HOME|CI)$/;
const FOLDER = /^[A-Za-z0-9_./-]+$/;

/** A stored row (or none) as the values the form and the builder use. */
export function previewSettingsValues(
  row: (Omit<PreviewSettingsValues, "buildVariables"> & { buildVariables: unknown }) | null | undefined,
): PreviewSettingsValues {
  if (!row) return { ...DEFAULT_PREVIEW_SETTINGS, buildVariables: {} };
  const variables: BuildVariables = {};
  if (row.buildVariables && typeof row.buildVariables === "object" && !Array.isArray(row.buildVariables)) {
    for (const [name, value] of Object.entries(row.buildVariables as Record<string, unknown>)) {
      if (typeof value === "string") variables[name] = value;
    }
  }
  return {
    enabled: row.enabled,
    rootDir: row.rootDir,
    installCommand: row.installCommand,
    buildCommand: row.buildCommand,
    outputDir: row.outputDir,
    nodeVersion: row.nodeVersion,
    buildVariables: variables,
  };
}

/** Build variables as the form shows them: one NAME=value per line, sorted by name. */
export function buildVariablesText(variables: BuildVariables): string {
  return Object.keys(variables)
    .sort()
    .map((name) => `${name}=${variables[name]}`)
    .join("\n");
}

const folder = (label: string) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required. Use . for the repository root.`)
    .max(200, `${label} is too long.`)
    .refine(
      (value) => FOLDER.test(value) && !value.startsWith("/") && !value.includes(".."),
      `${label} must be a relative path of letters, digits, dots, dashes, underscores and slashes, without "..".`,
    );

const command = (label: string) =>
  z
    .string()
    .trim()
    .max(300, `${label} is too long.`)
    .refine((value) => !/[\r\n\0]/.test(value), `${label} must be one line.`);

const buildVariablesInput = z
  .string()
  .max(20_000, "Build variables are too long.")
  .transform((text, ctx): BuildVariables => {
    const variables: BuildVariables = {};
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
    for (const line of lines) {
      const equals = line.indexOf("=");
      const name = equals === -1 ? line : line.slice(0, equals).trim();
      if (equals === -1 || !NAME.test(name)) {
        ctx.addIssue({
          code: "custom",
          message: `"${line.slice(0, 40)}" isn't NAME=value. Names use capital letters, digits and underscores, and don't start with a digit.`,
        });
        return z.NEVER;
      }
      if (RESERVED_NAME.test(name)) {
        ctx.addIssue({ code: "custom", message: `${name} is reserved for the build machine. Use another name.` });
        return z.NEVER;
      }
      if (name in variables) {
        ctx.addIssue({ code: "custom", message: `${name} is set twice.` });
        return z.NEVER;
      }
      const value = line.slice(equals + 1).trim();
      if (value.length > 2000) {
        ctx.addIssue({ code: "custom", message: `${name}'s value is too long.` });
        return z.NEVER;
      }
      variables[name] = value;
    }
    if (Object.keys(variables).length > MAX_BUILD_VARIABLES) {
      ctx.addIssue({ code: "custom", message: `At most ${MAX_BUILD_VARIABLES} build variables.` });
      return z.NEVER;
    }
    return variables;
  });

export const previewSettingsSchema = z.object({
  enabled: z.boolean(),
  rootDir: folder("Root folder"),
  installCommand: command("Install command").transform((value) => value || null),
  buildCommand: command("Build command").min(1, "Build command is required."),
  outputDir: folder("Output folder"),
  nodeVersion: z
    .string()
    .trim()
    .regex(/^[0-9]{2}(\.[0-9]+){0,2}$/, "Node version must look like 22 or 22.12.0."),
  buildVariables: buildVariablesInput,
});
