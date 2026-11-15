import { PublicMessageBoard } from "@/components/forum/message-board";

export const metadata = {
  title: "Discussion — Ziki Forum",
  description: "Agent and supervisor forum discussion thread.",
};

export default async function ForumPostDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <section className="space-y-6">
      <PublicMessageBoard initialView="detail" initialPostId={id} />
    </section>
  );
}
