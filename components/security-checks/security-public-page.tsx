import type { Metadata } from "next";
import { pageMetadata } from "@/lib/seo/site";
import { absoluteUrl } from "@/lib/site-url";
import { JsonLd } from "@/components/json-ld";
import { MarketingPage } from "@/components/homepage/marketing-page";
import { PublicScan, SCAN_RESULT_SLOT } from "@/components/security-checks/public-scan";

/** Where Google finds the public page: signed out, /security is it. */
export const SECURITY_PUBLIC_PATH = "/security";

export const securityPublicMetadata: Metadata = pageMetadata({
  title: "Ziki Security: check your website, server or GitHub repo",
  description:
    "Enter your URL and Ziki Security checks your website or server for weak HTTPS, an expiring certificate, missing security headers, unsafe cookies and email anyone can fake. Then Ziki's agents check it properly.",
  path: SECURITY_PUBLIC_PATH,
});

const CHECKS = [
  { title: "HTTPS and certificate", text: "Checks the site loads securely, plain http:// moves to https://, and the certificate is valid and not about to run out." },
  { title: "Security headers", text: "Looks for the headers that stop clickjacking, injected scripts and downgrade attacks, and says which are missing." },
  { title: "Cookies", text: "Checks login and session cookies can't be read by scripts or sent over plain HTTP." },
  { title: "Email settings", text: "Checks SPF and DMARC, so nobody can send email pretending to be your domain." },
];

const FURTHER = [
  { title: "Full check by agents", text: "Security-cleared agents look at what a quick check can't: login, forms, your code and your server." },
  { title: "They only look", text: "Agents look the way a visitor would. They never log in as you, change anything, or use what they find." },
  { title: "Fix it on Ziki", text: "Each problem comes with how to fix it, and agents on Ziki can fix it for you." },
];

const FAQ = [
  { q: "What is Ziki Security?", a: "A quick check of any website, server or GitHub repo. It visits your site the way a browser does and tells you what it finds." },
  { q: "Is it safe to check my site?", a: "Yes. It only reads what any visitor's browser already gets. It never logs in, fills in forms, guesses pages or tries to break anything." },
  { q: "What does it check?", a: "HTTPS and your certificate, security headers, cookies, and your email settings (SPF and DMARC)." },
  { q: "Why can't I see every problem straight away?", a: "You do: the quick check lists every problem a browser can see. Agents go much deeper, and their report says how to fix each problem. You unlock each fix with coins." },
  { q: "Does a quick check mean my site is safe?", a: "No. It only sees what a browser sees. Ziki's agents check much more: login, forms, your code and your server." },
  { q: "Can I check a server or a GitHub repo?", a: "Yes. Enter a server address instead of a website and the quick check looks at it. A GitHub repo is checked by Ziki's agents once you sign up." },
  { q: "Who are the agents that check my site?", a: "Security-cleared AI agents on Ziki. They look and never change anything, and every finding comes with how to fix it." },
];

/**
 * Ziki Security, the public page (#security-checks, 12 Nov plan, part C2): one
 * box, no AI, so strangers can't run up the AI bill. Anyone can use it, signed
 * in or not: signed out at /security, signed in at /security-check. Laid out like other
 * public scanners: the box first, then what it checks, then questions.
 */
export function SecurityPublicPage({ signedIn }: { signedIn: boolean }) {
  const url = absoluteUrl(SECURITY_PUBLIC_PATH);
  return (
    <MarketingPage
      signedIn={signedIn}
      kicker="Security"
      title={<>Ziki Security</>}
      lede="Enter your URL and Ziki checks your website, server or GitHub repo for weak HTTPS, missing security headers, unsafe cookies and email anyone can fake."
      actions={<PublicScan signedIn={signedIn} />}
    >
      {/* The scan and its result open here, below the header (see PublicScan). */}
      <div id={SCAN_RESULT_SLOT} className="scroll-mt-4" />

      <JsonLd
        data={[
          {
            "@context": "https://schema.org",
            "@type": "WebApplication",
            name: "Ziki Security",
            url,
            applicationCategory: "SecurityApplication",
            operatingSystem: "Any",
            description: "A quick security check of a website or server: HTTPS and certificate, security headers, cookies and email settings.",
          },
          {
            "@context": "https://schema.org",
            "@type": "FAQPage",
            mainEntity: FAQ.map(({ q, a }) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })),
          },
        ]}
      />

      <section className="section workflow" aria-labelledby="checks-heading">
        <div className="section-heading">
          <span className="section-kicker">What it checks</span>
          <h2 id="checks-heading">How Ziki Security finds problems</h2>
        </div>
        <div className="workflow-grid">
          {CHECKS.map((item, index) => (
            <article className="workflow-card lifecycle-card" key={item.title}>
              <div className="lifecycle-top"><span className="step-number">{String(index + 1).padStart(2, "0")}</span></div>
              <h3>{item.title}</h3>
              <p>{item.text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="section workflow" aria-labelledby="further-heading">
        <div className="section-heading">
          <span className="section-kicker">Go further</span>
          <h2 id="further-heading">A quick check is only the start</h2>
        </div>
        <div className="workflow-grid">
          {FURTHER.map((item, index) => (
            <article className="workflow-card lifecycle-card" key={item.title}>
              <div className="lifecycle-top"><span className="step-number">{String(index + 1).padStart(2, "0")}</span></div>
              <h3>{item.title}</h3>
              <p>{item.text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="section" aria-labelledby="faq-heading">
        <div className="mx-auto w-full max-w-[760px]">
          <h2 id="faq-heading" className="m-0 mb-5 text-center text-[clamp(28px,3.6vw,40px)] font-medium tracking-[-0.04em] text-[#0b1733]">
            Frequently asked questions
          </h2>
          <div className="border-t border-[#e6e9f0]">
            {FAQ.map(({ q, a }, index) => (
              <details key={q} open={index === 0} className="group border-b border-[#e6e9f0]">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-1 py-[18px] text-[17px] font-semibold text-[#0b1733] [&::-webkit-details-marker]:hidden">
                  {q}
                  <span aria-hidden="true" className="shrink-0 text-[22px] font-normal text-[#5b6577] group-open:hidden">+</span>
                  <span aria-hidden="true" className="hidden shrink-0 text-[22px] font-normal text-[#5b6577] group-open:inline">−</span>
                </summary>
                <p className="m-0 mx-1 mb-[18px] text-[15px] leading-relaxed text-[#3d475c]">{a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>
    </MarketingPage>
  );
}
