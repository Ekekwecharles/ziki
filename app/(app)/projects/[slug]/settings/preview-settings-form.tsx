"use client";

import { useActionState, useState } from "react";
import {
  updateProjectPreviewSettingsAction,
  type PreviewSettingsActionResult,
} from "./preview-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  buildVariablesText,
  MAX_BUILD_VARIABLES,
  type PreviewSettingsValues,
} from "@/lib/validations/preview-settings";

const TEXT_FIELDS: Array<{
  name: "rootDir" | "installCommand" | "buildCommand" | "outputDir" | "nodeVersion";
  label: string;
  hint: string;
  placeholder?: string;
}> = [
  { name: "rootDir", label: "Root folder", hint: "Where to build, relative to the repository root. Use . for the root." },
  {
    name: "installCommand",
    label: "Install command",
    hint: "Leave empty to pick it from the lock file, for example npm ci or pnpm install.",
    placeholder: "Detected from the lock file",
  },
  { name: "buildCommand", label: "Build command", hint: "Run in the root folder." },
  { name: "outputDir", label: "Output folder", hint: "The built files, relative to the root folder, for example dist or out." },
  { name: "nodeVersion", label: "Node version", hint: "For example 22 or 22.12.0." },
];

export function PreviewSettingsForm({
  slug,
  settings,
  repoUrl,
}: {
  slug: string;
  settings: PreviewSettingsValues;
  repoUrl: string | null;
}) {
  const [result, action, pending] = useActionState<PreviewSettingsActionResult | undefined, FormData>(
    updateProjectPreviewSettingsAction,
    undefined,
  );
  const fieldErrors = result && !result.ok ? result.fieldErrors : undefined;
  const [enabled, setEnabled] = useState(settings.enabled);

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="slug" value={slug} />
      {result && !result.ok ? (
        <p role="alert" className="rounded-[14px] bg-zk-bad-bg p-3 text-sm text-zk-bad-fg">
          {result.error}
        </p>
      ) : null}

      <div className="flex items-start justify-between gap-4">
        <span className="text-sm text-zk-text">
          <span id="preview-enabled-label" className="font-medium">Build previews of pull requests</span>
          <span id="preview-enabled-hint" className="block text-xs font-normal text-zk-muted">
            {repoUrl ? `For the main repository, ${repoUrl}. ` : "The project has no main repository yet. "}
            Previews are public links: anyone with a link can open one, including for a private repository.
          </span>
          {fieldErrors?.enabled ? <span className="block text-xs text-zk-bad-fg">{fieldErrors.enabled}</span> : null}
        </span>
        {enabled ? <input type="hidden" name="enabled" value="on" /> : null}
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-labelledby="preview-enabled-label"
          aria-describedby="preview-enabled-hint"
          aria-invalid={fieldErrors?.enabled ? true : undefined}
          onClick={() => setEnabled((on) => !on)}
          className={`relative h-7 w-[46px] shrink-0 rounded-full border-0 p-0 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-electric-blue focus-visible:ring-offset-2 ${
            enabled ? "bg-electric-blue-strong" : "bg-zk-chip"
          }`}
        >
          <span
            className={`pointer-events-none absolute top-[3px] h-[22px] w-[22px] rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.25)] transition-[left] motion-reduce:transition-none ${
              enabled ? "left-[21px]" : "left-[3px]"
            }`}
          />
        </button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {TEXT_FIELDS.map((field) => {
          const error = fieldErrors?.[field.name];
          const value = settings[field.name] ?? "";
          return (
            <label key={field.name} htmlFor={`preview-${field.name}`} className="block space-y-1 text-sm font-medium text-zk-text">
              {field.label}
              <Input
                id={`preview-${field.name}`}
                name={field.name}
                defaultValue={value}
                placeholder={field.placeholder}
                spellCheck={false}
                autoComplete="off"
                aria-describedby={`preview-${field.name}-hint`}
                aria-invalid={error ? true : undefined}
              />
              <span id={`preview-${field.name}-hint`} className="block text-xs font-normal text-zk-muted">
                {field.hint}
              </span>
              {error ? <span className="block text-xs text-zk-bad-fg">{error}</span> : null}
            </label>
          );
        })}
      </div>

      <label htmlFor="preview-buildVariables" className="block space-y-1 text-sm font-medium text-zk-text">
        Build variables
        <Textarea
          id="preview-buildVariables"
          name="buildVariables"
          rows={4}
          defaultValue={buildVariablesText(settings.buildVariables)}
          placeholder="VITE_API_URL=https://staging-api.example.com"
          spellCheck={false}
          className="font-mono"
          aria-describedby="preview-buildVariables-hint"
          aria-invalid={fieldErrors?.buildVariables ? true : undefined}
        />
        <span id="preview-buildVariables-hint" className="block text-xs font-normal text-zk-muted">
          One NAME=value per line, at most {MAX_BUILD_VARIABLES}. These are built into the frontend code, so anyone can read
          them: never put a secret, key or password here.
        </span>
        {fieldErrors?.buildVariables ? (
          <span className="block text-xs text-zk-bad-fg">{fieldErrors.buildVariables}</span>
        ) : null}
      </label>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save previews"}
        </Button>
        {result?.ok ? <span role="status" className="text-sm text-zk-ok-fg">Preview settings saved.</span> : null}
      </div>
    </form>
  );
}
