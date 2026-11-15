
/** The Output box's heading; the project breadcrumb above the page says where it is. */
export function LibraryHeading() {
  return <>
    <header className="lb-heading"><div><h1>Output box</h1><p>The finished work. All in one place.</p></div>
      <span className="lb-published"><span aria-hidden="true">✓</span> Live · Published only</span>
    </header>
  </>;
}
