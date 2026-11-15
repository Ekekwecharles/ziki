import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireProject } from "@/lib/project-route";
import { issuesPath, projectPath } from "@/lib/project-paths";
import { humanNotesActor, readProjectNotes, listNoteComments, listNoteRevisions } from "@/lib/project-notes";
import { RichText } from "@/components/rich-text";
import { NotesDocument } from "./notes-document";
import { AddNoteButton, NoteCommentComposer, NoteReplyForm } from "./note-comments";
import { NoteCommentVoteBadge } from "@/components/vote-badge";

export const metadata = { title: "Project notes" };
/** `/<slug>/notes` (#project-urls): the slug picks the project and checks access. */
export default async function NotesPage({ params: routeParams, searchParams }: { params: Promise<{ org: string; project: string }>; searchParams: Promise<{ cursor?: string; history?: string }> }) {
  const { org, project: slugParam } = await routeParams;
  const { user, organisationId, project: current, isOrgMember, isProjectMember } = await requireProject(org, slugParam);
  if (!isOrgMember && !isProjectMember && user.role !== "super_admin") notFound();
  const projectId = current.id;
  const slug = current.ref;
  const params = await searchParams;
  const actor = await humanNotesActor(user, organisationId, projectId);
  const [project, result, comments, revisions] = await Promise.all([
    prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { name: true } }),
    readProjectNotes(actor),
    listNoteComments(actor, new URLSearchParams(params.cursor ? { cursor: params.cursor } : {})),
    listNoteRevisions(actor, new URLSearchParams({ limit: "10", ...(params.history ? { cursor: params.history } : {}) })),
  ]);
  const pageHref = (key: "cursor" | "history", cursor: string) => {
    const next = new URLSearchParams({ ...(params.cursor ? { cursor: params.cursor } : {}), ...(params.history ? { history: params.history } : {}), [key]: cursor });
    return `${projectPath(slug, "/notes")}?${next}`;
  };
  return (
    <div className="mx-auto w-full max-w-6xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-extrabold tracking-tight text-zk-text">Project notes</h1>
        <div className="flex items-center gap-2">
          <AddNoteButton />
          <Link href={issuesPath(slug)} className="rounded-lg border border-zk-border px-3 py-2 text-sm font-semibold text-zk-text hover:bg-zk-chip">Back to issues</Link>
        </div>
      </div>
      <NotesDocument key={projectId} projectId={projectId} canEdit={result.canEdit}
        notes={result.notes ? { ...result.notes, updatedAt: result.notes.updatedAt.toISOString() } : null}
        revisions={revisions.items.map((revision) => ({ ...revision, createdAt: revision.createdAt.toISOString() }))}
        historyLink={revisions.nextCursor ? pageHref("history", revisions.nextCursor) : undefined} />
      <section aria-labelledby="notes-discussion-heading" className="rounded-[20px] border border-zk-border bg-zk-surface">
        <div className="border-b border-zk-border px-5 py-4 sm:px-7">
          <h2 id="notes-discussion-heading" className="text-base font-bold text-zk-text">Notes from the team</h2>
          <p className="mt-1 text-sm text-zk-text2">What members and their agents have learned about this project, and replies that correct or adapt it. Votes show what is useful; they do not change the official notes, which editors update when something changes.</p>
        </div>
        <NoteCommentComposer projectId={projectId} />
        {comments.items.length ? <ol className="divide-y divide-zk-border px-5 sm:px-7">{comments.items.map((comment) => (
          <li id={`comment-${comment.id}`} key={comment.id} className="flex gap-4 py-5">
            {/* The same vote box as the issue and idea lists: up and down, one vote per person. */}
            <div className="w-[52px] shrink-0 pt-0.5">
              <NoteCommentVoteBadge projectId={projectId} commentId={comment.id} upvotes={comment.upvotes} downvotes={comment.downvotes} myVote={comment.myVote === 1 ? 1 : comment.myVote === -1 ? -1 : 0} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-bold text-zk-text">{comment.authorName} <span className="font-normal text-zk-muted">· {comment.agentId ? "Agent" : "Member"}</span></p><time dateTime={comment.createdAt.toISOString()} className="text-xs text-zk-muted">{comment.createdAt.toISOString().slice(0, 16).replace("T", " ")} UTC</time></div>
              <RichText content={comment.body} className="text-zk-text" />
              <NoteReplyForm projectId={projectId} parentId={comment.id} />
              {/* Replies: corrections and adaptations, each in its own box on the thread line. */}
              {comment.replies.length ? (
                <ul aria-label="Replies" className="m-0 mt-2 ml-2 flex list-none flex-col p-0">
                  {comment.replies.map((reply, index) => (
                    <li key={reply.id} id={`comment-${reply.id}`} className="relative pl-6 pt-2">
                      {index < comment.replies.length - 1 ? <span aria-hidden="true" className="absolute bottom-0 left-0 top-0 border-l-2 border-zk-divider" /> : null}
                      <span aria-hidden="true" className="absolute left-0 top-0 h-7 w-5 rounded-bl-lg border-b-2 border-l-2 border-zk-divider" />
                      <div className="flex gap-3 rounded-xl border border-zk-border bg-zk-surface px-3 py-2.5">
                        <div className="w-[44px] shrink-0">
                          <NoteCommentVoteBadge projectId={projectId} commentId={reply.id} upvotes={reply.upvotes} downvotes={reply.downvotes} myVote={reply.myVote === 1 ? 1 : reply.myVote === -1 ? -1 : 0} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="m-0 flex flex-wrap items-center gap-x-2 text-[13px]">
                            <span className="text-zk-muted" aria-hidden="true">↳</span>
                            <b className="font-semibold text-zk-text">{reply.authorName}</b>
                            <span className="text-zk-muted">· {reply.agentId ? "Agent" : "Member"}</span>
                            <time dateTime={reply.createdAt.toISOString()} className="text-xs text-zk-muted">· {reply.createdAt.toISOString().slice(0, 16).replace("T", " ")} UTC</time>
                          </p>
                          <RichText content={reply.body} className="text-sm text-zk-text" />
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </li>
        ))}</ol> : <p className="px-5 py-10 text-center text-sm text-zk-text2">No notes yet. Add the first one above; agents can add theirs through the project notes API.</p>}
        {comments.nextCursor ? <Link href={pageHref("cursor", comments.nextCursor)} className="m-5 inline-block text-sm font-semibold text-zk-accent underline">Next comments</Link> : null}
        {params.cursor || params.history ? <Link href={projectPath(slug, "/notes")} className="m-5 inline-block text-sm text-zk-accent underline">Latest notes and first comments</Link> : null}
      </section>
    </div>
  );
}
