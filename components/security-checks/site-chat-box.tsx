"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { askSite, siteChat } from "@/app/actions/security-assistant";

type Message = { id: string; role: "user" | "assistant"; text: string };

const MESSAGE_MAX = 600;

/**
 * The chat under one site's result (#security-checks, 14 Nov call): the earlier
 * conversation about that site, carried on. It's saved, so it's still here after
 * a refresh or on another device. Just the messages and the box; loads when the
 * result opens.
 */
export function SiteChatBox({ checkId, site }: { checkId: string; site: string }) {
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const log = useRef<HTMLOListElement>(null);

  useEffect(() => {
    let live = true;
    siteChat(checkId)
      .then((answer) => {
        if (!live) return;
        if (answer.ok) setMessages(answer.messages);
        else setError(answer.error);
      })
      .catch(() => live && setError("This chat couldn't load just now."));
    return () => {
      live = false;
    };
  }, [checkId]);

  useEffect(() => {
    log.current?.lastElementChild?.scrollIntoView({ block: "nearest" });
  }, [messages, pending]);

  function send() {
    const question = text.trim();
    if (!question || pending) return;
    setText("");
    setError(null);
    // Show the question straight away; the saved conversation replaces it when the answer is in.
    setMessages((current) => [...(current ?? []), { id: `pending-${Date.now()}`, role: "user", text: question }]);
    start(async () => {
      try {
        const answer = await askSite(checkId, question);
        if (answer.ok) setMessages(answer.messages);
        else setError(answer.error);
      } catch {
        setError("Couldn't send that just now. Try again.");
      }
    });
  }

  return (
    <section aria-label={`Chat about ${site}`} className="mt-3 flex flex-col gap-2 rounded-2xl border border-zk-border bg-zk-surface p-3 sm:p-4">
      {messages && messages.length ? (
        <ol ref={log} className="m-0 flex max-h-80 list-none flex-col gap-2 overflow-y-auto p-0">
          {messages.map((message) => (
            <li key={message.id} className={message.role === "user" ? "ml-auto max-w-[85%]" : "mr-auto max-w-[90%]"}>
              <p
                className={`m-0 whitespace-pre-wrap break-words px-3.5 py-2 text-[14px] ${
                  message.role === "user"
                    ? "rounded-[16px] rounded-br-md bg-electric-blue-strong text-white"
                    : "rounded-[16px] rounded-tl-md border border-zk-border bg-zk-bg text-zk-text2"
                }`}
              >
                <span className="sr-only">{message.role === "user" ? "You: " : "Reply: "}</span>
                {message.text}
              </p>
            </li>
          ))}
          {pending ? (
            <li className="mr-auto">
              <p className="m-0 rounded-[16px] rounded-tl-md border border-zk-border bg-zk-bg px-3.5 py-2 text-[14px] text-zk-muted">Thinking…</p>
            </li>
          ) : null}
        </ol>
      ) : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
        className="flex items-end gap-2"
      >
        <label htmlFor={`site-chat-${checkId}`} className="sr-only">
          Ask about {site}
        </label>
        <textarea
          id={`site-chat-${checkId}`}
          rows={1}
          value={text}
          maxLength={MESSAGE_MAX}
          disabled={pending}
          placeholder={`Ask about ${site}`}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
          className="min-h-[40px] flex-1 resize-none rounded-xl border border-zk-border bg-zk-surface px-3 py-2 text-[14px] text-zk-text placeholder:text-zk-muted focus:border-electric-blue-strong/60 focus:outline-none"
        />
        <button
          type="submit"
          disabled={pending || !text.trim()}
          aria-label="Send"
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-zk-text text-zk-surface transition disabled:opacity-30"
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 19V5M5 12l7-7 7 7" />
          </svg>
        </button>
      </form>
      {error ? (
        <p role="alert" className="m-0 text-[13px] text-zk-bad-fg">
          {error}
        </p>
      ) : null}
    </section>
  );
}
