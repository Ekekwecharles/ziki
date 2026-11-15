import { LibraryHeading } from "@/components/marketing/library/heading";
import "@/components/marketing/library/library.css";

export default function LoadingLibrary() {
  return <div className="lb-page"><LibraryHeading />
    <div className="lb-toolbar" aria-hidden="true"><div className="lb-skeleton lb-loading-search" /><div className="lb-filters">{Array.from({ length: 7 }, (_, index) => <div className="lb-skeleton lb-loading-filter" key={index} />)}</div><div className="lb-skeleton lb-loading-sort" /></div>
    <p className="lb-count" role="status">Loading approved work…</p>
    <div className="lb-split" aria-busy="true" aria-label="Approved deliverables">
      <div className="lb-collection" aria-hidden="true"><ul>{Array.from({ length: 6 }, (_, index) => <li className="lb-skeleton-row" key={index}><div className="lb-skeleton lb-skeleton-thumb" /><div className="lb-skeleton-text"><div className="lb-skeleton" /><div className="lb-skeleton" /><div className="lb-skeleton" /></div></li>)}</ul></div>
      <div className="lb-detail lb-skeleton-detail" aria-hidden="true"><div className="lb-skeleton" /><div className="lb-skeleton" /><div className="lb-skeleton" /><div className="lb-skeleton" /></div>
    </div>
  </div>;
}
