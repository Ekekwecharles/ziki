const block = "rounded-lg bg-zk-chip motion-safe:animate-pulse";

export default function LoadingMarketingHome() {
  return (
    <>
      <p role="status" className="sr-only">Loading Marketing…</p>
      <div aria-hidden="true" className="mx-auto flex w-full max-w-3xl flex-col items-center gap-4 pt-10 sm:pt-16">
        <div className={`${block} h-8 w-full max-w-md`} />
        <div className={`${block} h-5 w-48`} />
        <div className={`${block} mt-2 h-32 w-full rounded-2xl`} />
      </div>
    </>
  );
}
