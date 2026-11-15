"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { FieldError, useFieldErrors } from "@/components/ui/field-errors";
import { Input } from "@/components/ui/input";
import { createOrganisationAction, type OrganisationFormResult } from "./actions";

const FORM_ID = "create-organisation";

/** Keep a field's hint announced alongside its error, not replaced by it. */
function withHint(hintId: string, errorAttrs: { "aria-invalid"?: true; "aria-describedby"?: string }) {
  return {
    ...errorAttrs,
    "aria-describedby": [hintId, errorAttrs["aria-describedby"]].filter(Boolean).join(" "),
  };
}

/**
 * Create a organisation you own (#444). It starts with no projects: they are
 * created from the organisation's Projects page. `nameMax` comes
 * from the server, so this client file doesn't import the server-only rules.
 */
export function CreateOrganisationForm({ nameMax, next }: { nameMax: number; next?: string }) {
  const formRef = useRef<HTMLFormElement>(null);
  const { fieldErrors, show, clear, attrs } = useFieldErrors(FORM_ID, formRef);
  // Controlled, so a failed submit keeps what was typed.
  const [name, setName] = useState("");
  const [result, action, pending] = useActionState<OrganisationFormResult | undefined, FormData>(
    createOrganisationAction,
    undefined,
  );

  useEffect(() => {
    if (!result) return;
    if (result.field) show(result);
    else clear();
  }, [result, show, clear]);

  const formError = result?.error && !result.field ? result.error : null;
  // #537: the server warned about a duplicate name. Submitting the same name
  // again confirms it; changing the name asks again.
  const confirmingDuplicate =
    Boolean(result?.duplicateName) && result?.duplicateName === name.replace(/\s+/g, " ").trim();

  return (
    <form ref={formRef} action={action} className="mt-4 space-y-4" noValidate>
      {/* Where to go once it's made: back to Security with the scanned site (checked again on the server). */}
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <div className="space-y-1">
        <label htmlFor="organisation-name" className="block text-sm font-medium text-zk-text">
          Organisation name
        </label>
        <p id="organisation-name-hint" className="text-xs text-zk-muted">
          Usually your company or team, such as Acme.
        </p>
        <Input
          id="organisation-name"
          name="name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Acme"
          autoComplete="organisation"
          required
          maxLength={nameMax + 20}
          disabled={pending}
          className="sm:max-w-sm"
          {...withHint("organisation-name-hint", attrs("name"))}
        />
        <FieldError formId={FORM_ID} field="name" errors={fieldErrors} />
      </div>
      {formError ? (
        <p role="alert" className="text-sm text-zk-bad-fg">
          {formError}
        </p>
      ) : null}
      {confirmingDuplicate ? <input type="hidden" name="confirmDuplicate" value={result?.duplicateName} /> : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Creating…" : confirmingDuplicate ? "Create anyway" : "Create organisation"}
        </Button>
        <p className="text-xs text-zk-muted">You&apos;ll be its owner.</p>
      </div>
    </form>
  );
}
