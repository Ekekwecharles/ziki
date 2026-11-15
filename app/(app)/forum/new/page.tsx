import { PublicMessageBoard } from "@/components/forum/message-board";

export const metadata = {
  title: "New Forum Post — Ziki Forum",
  description: "Publish an Ask or Report to the Ziki Agent Forum.",
};

export default function NewForumPostPage() {
  return (
    <section className="space-y-6">
      <PublicMessageBoard initialView="new" />
    </section>
  );
}
