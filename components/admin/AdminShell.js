// components/admin/AdminShell.js  (new file)
//
// Persistent admin frame: blue left sidebar + top bar. It lives in
// app/admin/layout.js, so it is NOT re-mounted when you click a sidebar item --
// only the {children} on the right swap and the URL changes.
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import p from "./adminPanel.module.css";
import { NAV_GROUPS, NAV_ITEMS, SUB_LABELS } from "./adminNav";

const ICONS = {
  grid: <><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /></>,
  users: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6M16 4.7a3.5 3.5 0 0 1 0 6.6M18 14.4c2 .7 3.5 2.6 3.5 5.6" /></>,
  book: <><path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z" /><path d="M4 21V5M9 7h6" /></>,
  folder: <><path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" /></>,
  clipboard: <><rect x="5" y="4" width="14" height="17" /><path d="M9 4V2h6v2M9 10h6M9 14h6M9 18h3" /></>,
  bot: <><rect x="4" y="8" width="16" height="12" /><path d="M12 8V4M9 13h.01M15 13h.01M9 17h6M2 13v3M22 13v3" /></>,
  chart: <><path d="M3 21h18M6 17v-6M11 17V5M16 17v-9M21 17v-4" /></>,
  plus: <><rect x="3" y="3" width="18" height="18" /><path d="M12 8v8M8 12h8" /></>,
  card: <><rect x="2" y="5" width="20" height="14" /><path d="M2 10h20M6 15h4" /></>,
  mail: <><rect x="3" y="5" width="18" height="14" /><path d="M3 7l9 6 9-6" /></>,
  bell: <><path d="M6 17V11a6 6 0 0 1 12 0v6l2 2H4zM10 21h4" /></>,
  gear: <><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1" /></>,
};

function Icon({ name }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="square" strokeLinejoin="miter" aria-hidden="true">
      {ICONS[name] || ICONS.grid}
    </svg>
  );
}

export default function AdminShell({ children, onLogout, loggingOut = false }) {
  const pathname = usePathname() || "/";
  const [me, setMe] = useState(null);
  const [open, setOpen] = useState(false); // mobile sidebar

  // On admin.<site> URLs have no /admin prefix; on the plain-path fallback they do.
  const prefixed = pathname === "/admin" || pathname.startsWith("/admin/");
  const base = prefixed ? "/admin" : "";
  const rest = prefixed ? pathname.slice("/admin".length) : pathname;
  const segments = rest.split("/").filter(Boolean);
  const activeSlug = segments[0] || "";
  const subLabel = segments[1] ? SUB_LABELS[`${segments[0]}/${segments[1]}`] || segments[1].replace(/-/g, " ") : "";
  const hrefFor = (slug) => (slug ? `${base}/${slug}` : base || "/");
  const current = NAV_ITEMS.find((i) => i.slug === activeSlug);

  useEffect(() => {
    let alive = true;
    fetch("/api/admin/me", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive && d) setMe(d); })
      .catch(() => {});
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => { alive = false; document.removeEventListener("keydown", onKey); };
  }, []);

  const email = me?.email || "Administrator";
  const role = me?.role || "Admin";

  return (
    <div className={p.root}>
      <div className={`${p.scrim} ${open ? p.scrimOn : ""}`} onClick={() => setOpen(false)} />

      {/* ============ LEFT SIDEBAR ============ */}
      <aside className={`${p.sidebar} ${open ? p.sidebarOpen : ""}`} aria-label="Admin navigation">
        <Link href={hrefFor("")} className={p.brand} onClick={() => setOpen(false)}>
          <img
            src="/images/other_images/class-logo.png"
            alt="Logo"
            className={p.brandLogo}
          />
          <span className={p.brandWords}>
            <span className={p.brandTag}>Admin Dashboard</span>
          </span>
        </Link>

        <nav className={p.nav}>
          {NAV_GROUPS.map((g) => (
            <div key={g.label} className={p.group}>
              <div className={p.groupLabel}>{g.label}</div>
              {g.items.map((item) => {
                const active = item.slug === activeSlug;
                return (
                  <Link
                    key={item.slug || "overview"}
                    href={hrefFor(item.slug)}
                    className={`${p.navBtn} ${active ? p.navBtnActive : ""}`}
                    aria-current={active ? "page" : undefined}
                    onClick={() => setOpen(false)}
                  >
                    <Icon name={item.icon} />
                    <span>{item.label}</span>
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        <div className={p.sideFoot}>Admin</div>
      </aside>

      {/* ============ MAIN AREA ============ */}
      <div className={p.main}>
        <header className={p.topbar}>
          <button type="button" className={p.menuBtn} aria-label="Open navigation" onClick={() => setOpen(true)}>
            <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z" /></svg>
          </button>
          <div className={p.crumbs}>
            <span className={p.crumbRoot}>Admin</span>
            <span className={p.crumbSep}>/</span>
            {subLabel ? (
              <>
                <Link href={hrefFor(activeSlug)} className={p.crumbLink}>{current ? current.label : "Page"}</Link>
                <span className={p.crumbSep}>/</span>
                <span className={p.crumbNow}>{subLabel}</span>
              </>
            ) : (
              <span className={p.crumbNow}>{current ? current.label : "Page"}</span>
            )}
          </div>
          <div className={p.account}>
            <div className={p.who}>
              <span className={p.whoEmail}>{email}</span>
              <span className={p.whoRole}>{role}</span>
            </div>
            <button type="button" className={p.logoutBtn} onClick={onLogout} disabled={loggingOut}>
              {loggingOut ? "Logging out..." : "Logout"}
            </button>
          </div>
        </header>

        <main className={p.content}>{children}</main>
      </div>
    </div>
  );
}
