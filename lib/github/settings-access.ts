import "server-only";
import { githubClientFor } from "@/lib/github/client";
import { parseGitHubRepoUrl } from "@/lib/github/pull-request-url";

/**
 * Per-repository access status for the project settings GitHub section: can
 * the connected GitHub App installation actually see each configured
 * repository? An installation granted only selected repositories fails here
 * for the others (GitHub answers 404), which the readiness page reports but
 * the settings page previously did not surface.
 */

export type RepositoryAccessState =
  | "ok" // the app installation read the repository
  | "not_accessible" // an installation is connected but cannot see it
  | "unverified" // readable, but not through an app installation
  | "no_installation" // nothing connected, nothing readable
  | "invalid_url"
  | "not_configured"
  | "check_failed"; // GitHub errored; no access conclusion

export type RepositoryAccess = {
  key: string;
  label: string;
  name: string;
  state: RepositoryAccessState;
  message: string;
};

const NOT_ACCESSIBLE_MESSAGE =
  "The connected GitHub App installation can't see this repository. On GitHub, open the app's settings for this organisation and add the repository under Repository access (or grant all repositories), then reload this page.";

export async function repositoryAccessForSettings(project: {
  repoUrl: string | null;
  githubInstallationId: string | null;
  repositories: { id: string; url: string; label: string | null; githubInstallationId: string | null }[];
}): Promise<RepositoryAccess[]> {
  const inputs = [
    { key: "main", label: "Main repository", url: project.repoUrl, installationId: project.githubInstallationId },
    ...project.repositories.map((repository) => ({
      key: repository.id,
      label: repository.label || "Added repository",
      url: repository.url as string | null,
      installationId: repository.githubInstallationId ?? project.githubInstallationId,
    })),
  ];

  return Promise.all(
    inputs.map(async ({ key, label, url, installationId }): Promise<RepositoryAccess> => {
      const ref = parseGitHubRepoUrl(url);
      if (!ref) {
        return url
          ? { key, label, name: url, state: "invalid_url", message: "This is not a valid GitHub repository address." }
          : { key, label, name: "Not configured", state: "not_configured", message: "Set the repository address in Details & rewards." };
      }
      const name = `${ref.owner}/${ref.repo}`;
      const path = `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;
      let client;
      try {
        client = await githubClientFor({ githubInstallationId: installationId });
        const repository = await client.getOrNull(path);
        if (repository) {
          return client.auth === "app"
            ? { key, label, name, state: "ok", message: "The GitHub App installation can read this repository." }
            : {
                key, label, name, state: "unverified",
                message: installationId
                  ? "Readable with a token or anonymous access, so app access is not verified."
                  : "No GitHub App installation is connected. Public or token access does not verify app access.",
              };
        }
        return installationId
          ? { key, label, name, state: "not_accessible", message: NOT_ACCESSIBLE_MESSAGE }
          : { key, label, name, state: "no_installation", message: "GitHub returned 404 and no installation is connected. The repository may be private, missing or renamed." };
      } catch {
        return { key, label, name, state: "check_failed", message: "GitHub could not complete this check. Reload to retry, or use the readiness page for details." };
      }
    }),
  );
}
