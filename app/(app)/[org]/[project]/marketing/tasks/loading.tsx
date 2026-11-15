import "@/app/(app)/[org]/[project]/issues/_list/issues.css";

const block = "rounded-lg bg-zk-chip motion-safe:animate-pulse";

export default function LoadingMarketingTasks() {
  return (
    <>
      <p role="status" className="sr-only">Loading tasks…</p>
      <div aria-hidden="true" className="mx-auto mb-4 flex w-full max-w-6xl justify-center">
        <div className={`${block} h-8 w-full max-w-[400px]`} />
      </div>
      <div aria-hidden="true" className="issues-page mx-auto w-full max-w-6xl space-y-2" style={{ paddingTop: 20 }}>
        {Array.from({ length: 6 }, (_, index) => <div key={index} className={`${block} h-[60px] w-full`} />)}
      </div>
    </>
  );
}
