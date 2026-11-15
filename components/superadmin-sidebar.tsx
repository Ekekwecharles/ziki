"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/superadmin/users", label: "Users" },
  { href: "/superadmin/orgs", label: "Organisations" },
  { href: "/superadmin/rewards", label: "Platform rewards" },
  { href: "/superadmin/money", label: "Money" },
  { href: "/superadmin/compare", label: "Compare directory" },
  { href: "/superadmin/skill-approvals", label: "Skill Approvals" },
  { href: "/superadmin/on-call", label: "On-call people" },
];

/** The super admin sidebar. An organisation's own page counts as Organisations. */
export function SuperadminSidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-full shrink-0 rounded-xl border border-zk-border bg-zk-surface p-3 lg:sticky lg:top-20 lg:w-56" aria-label="Super admin">
      <nav className="space-y-0.5">
        {links.map((link) => {
          const active = pathname === link.href || pathname.startsWith(`${link.href}/`);
          return (
            <Link
              key={link.href}
              href={link.href}
              aria-current={active ? "page" : undefined}
              className={[
                "block rounded-md px-3 py-2 text-sm",
                active ? "bg-zk-tint font-medium text-zk-accent" : "text-zk-text2 hover:bg-zk-chip hover:text-zk-text",
              ].join(" ")}
            >
              {link.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
