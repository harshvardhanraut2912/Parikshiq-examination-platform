// SAVE THIS FILE AT: C:\dev\proxy.js  (replace the existing file)
import { NextResponse } from 'next/server';
import { verifyAdminTokenDetailed, ADMIN_COOKIE_NAME } from '@/lib/adminAuth';

// Fire-and-forget insert into Supabase's REST API — deliberately NOT
// awaited by the caller (see `context.waitUntil` usage below), so logging
// never adds latency to the actual response. Uses plain fetch() against
// Supabase's PostgREST endpoint instead of the supabase-js client, since
// that client isn't guaranteed to work in the edge runtime middleware runs in.
async function logAdminAccess({ request, path, method, result, email, success, entryMethod, reason }) {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceKey) return;

    const ip =
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      request.headers.get('x-real-ip') ||
      'unknown';

    await fetch(`${supabaseUrl}/rest/v1/admin_access_logs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        attempted_email: email || null,
        path,
        method,
        result, // 'granted' | 'denied' | 'expired' | 'forged'
        success,
        entry_method: entryMethod,
        reason,
        ip_address: ip,
        user_agent: request.headers.get('user-agent') || 'unknown',
      }),
    });
  } catch (e) {
    // Logging failures must never block or break the actual request.
    console.error('admin_access_logs insert failed:', e);
  }
}

// ============================================================
// MAINTENANCE MODE
// Reads the `site_settings` row (key = 'maintenance_mode') straight from
// Supabase's REST API using the service-role key -- the same fetch-based
// approach logAdminAccess() above already uses, since supabase-js isn't
// guaranteed to work in the edge runtime this file executes in.
//
// `next: { revalidate: 5 }` lets Next.js's fetch cache serve this for up
// to 5 seconds before re-checking, so toggling the switch in the admin
// panel takes effect for every visitor within ~5 seconds without hitting
// the DB on every single request.
// ============================================================
async function isMaintenanceModeEnabled() {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceKey) return false;

    const res = await fetch(
      `${supabaseUrl}/rest/v1/maintenance_settings?select=enabled&limit=1`,
      {
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
        next: { revalidate: 5 },
      }
    );
    if (!res.ok) return false;

    const rows = await res.json();
    return rows?.[0]?.enabled === true;
  } catch (e) {
    // If Supabase is unreachable, fail OPEN (site stays live) rather than
    // accidentally locking everyone out because of a transient DB blip.
    console.error('maintenance mode check failed:', e);
    return false;
  }
}

// ============================================================
// ADMIN SUBDOMAIN
// The admin panel is served from admin.<site> (e.g. admin.localhost:3000 in
// dev, admin.yourdomain.in in production). On that host:
//   "/"            -> internally rewritten to /admin   (dashboard / sign-in)
//   "/users"       -> internally rewritten to /admin/users, and so on
//   "/admin/..."   -> still works (existing links); plain page loads get
//                     redirected to the shorter URL
//   student pages (/dashboard, /exam, /login ...) are NOT reachable there
// On the main host, the admin panel remains available under /admin.
// /api/admin/* and /api/admin-login|check|logout keep working on BOTH hosts
// (the mobile admin app calls them on the main host).
//
// Hosts where a subdomain can't exist (raw IPs, *.vercel.app, tunnels) keep
// serving the panel at <host>/admin. You can also force that everywhere with
// the env var ADMIN_PATH_FALLBACK=true (useful until your domain is ready).
// ============================================================
function canUseAdminSubdomain(host) {
  if (process.env.ADMIN_PATH_FALLBACK === 'true') return false;
  const bare = host.split(':')[0];
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(bare)) return false;      // 192.168.x.x etc.
  if (bare.endsWith('.vercel.app')) return false;                 // can't add subdomains to these
  if (bare.endsWith('.trycloudflare.com')) return false;
  if (bare.endsWith('.ngrok-free.app') || bare.endsWith('.ngrok.io')) return false;
  return true;
}

export async function proxy(request, context) {
  const { pathname, searchParams } = request.nextUrl;

  // Normalize the hostname separately from its optional port / trailing dot.
  // Vercel and local development can supply either form in the Host header.
  const host = (request.headers.get('host') || '').toLowerCase();
  const bareHost = host.split(':')[0].replace(/\\.$/, '');
  // Keep this host-based rather than hard-coding one domain so the same
  // deployment can serve admin.<any-connected-domain> once that hostname is
  // attached to the Vercel project and its DNS points to this deployment.
  const isAdminHost = bareHost.startsWith('admin.');
  const proto = request.headers.get('x-forwarded-proto') || request.nextUrl.protocol.replace(':', '') || 'https';
  // Absolute URL on the host the browser actually used (keeps admin.<site> in redirects).
  const hostUrl = (path) => `${proto}://${host}${path}`;

  // 1. GLOBAL BYPASS: Static assets or authentication callbacks
  if (
    pathname.startsWith('/_next') || 
    (!isAdminHost && (
      searchParams.has('code') || 
      searchParams.has('access_token') || 
      request.url.includes('access_token=')
    ))
  ) {
    return NextResponse.next();
  }

  // 1-admin. ADMIN SUBDOMAIN ROUTING (see the block comment above proxy()).
  const isRealAdminPagePath = pathname === '/admin' || pathname.startsWith('/admin/');
  const isApiRequest = pathname.startsWith('/api/') || pathname === '/api';

  // The main-domain root (/) is the public Parikshiq homepage.
  // Do not redirect visitors to /dashboard here; student dashboard access
  // remains available explicitly at /dashboard and keeps its existing auth gate.
  // /admin is reached ONLY by opening an /admin URL (or the admin.<domain> host) directly.

  // CUSTOM-DOMAIN COMPATIBILITY:
  // Keep the admin panel at /admin on the primary domain. Redirecting
  // /admin to admin.<domain> requires that subdomain to be separately
  // attached and configured in Vercel; otherwise Vercel returns
  // DEPLOYMENT_NOT_FOUND even though the same app works on its vercel.app URL.
  // The primary domain therefore serves /admin directly. The optional
  // admin-subdomain URL handling below remains available if that subdomain
  // is explicitly configured later.

  // Admin host: plain page loads of /admin/... get the shorter URL. (RSC /
  // prefetch requests are left alone so client-side navigation keeps working.)
  if (
    isAdminHost && isRealAdminPagePath && request.method === 'GET' &&
    request.headers.get('sec-fetch-dest') === 'document' &&
    !request.headers.get('rsc') && !searchParams.has('_rsc')
  ) {
    const stripped = pathname.replace(/^\/admin/, '') || '/';
    return NextResponse.redirect(hostUrl(stripped + request.nextUrl.search), 308);
  }

  // Admin host: which /admin/... page does this URL map to? (static files such
  // as /images/logo.png contain a "." and are served as-is.)
  let effectivePath = pathname;
  if (isAdminHost && !isApiRequest && !pathname.includes('.') && !isRealAdminPagePath) {
    effectivePath = pathname === '/' ? '/admin' : '/admin' + pathname;
  }

  // 1a. MAINTENANCE MODE — runs before every other rule below, and covers
  // every PAGE url on the site (dashboard, exam, profile, login,
  // marketing pages, course pages, unknown/mistyped urls), whether or
  // not it's in validSystemRoutes further down, whether or not it even
  // exists.
  //
  // API routes (/api/*) are deliberately EXCLUDED from this check and
  // always pass through untouched, maintenance or not -- the mobile app
  // calls these same API routes directly for its own data fetching, and
  // website maintenance mode is only meant to take the website's PAGES
  // offline, not the underlying API the app also depends on. (The app
  // has its own separate app_enabled maintenance flag -- see
  // lib/maintenance.ts on the app side -- for taking the app itself
  // offline.)
  //
  // The only things allowed through while maintenance is on are:
  //   - every /api/* route, for the reason above (this also covers
  //     /admin/* API routes and admin-login/check/logout, so those don't
  //     need their own separate carve-out any more)
  //   - /admin and every nested /admin/* PAGE — so an admin can still
  //     log in and flip the toggle back off
  //   - the maintenance page's own asset (maintenance.html) and favicon,
  //     so the rewrite below doesn't loop on itself
  const isApiPath = pathname.startsWith('/api/') || pathname === '/api';
  const isAdminPagePath = isAdminHost || pathname === '/admin' || pathname.startsWith('/admin/');
  const isMaintenanceAsset = pathname === '/maintenance.html' || pathname === '/favicon.ico';

  if (!isApiPath && !isAdminPagePath && !isMaintenanceAsset) {
    const underMaintenance = await isMaintenanceModeEnabled();
    if (underMaintenance) {
      return NextResponse.rewrite(new URL('/maintenance.html', request.url), { status: 503 });
    }
  }

  // 1a-2. /cources was a static file (public/cources.html) and is now a real
  // Next.js page at /cources. Anyone with the old .html URL bookmarked or
  // linked gets a permanent redirect to the new one.
  if (pathname === '/cources.html') {
    return NextResponse.redirect(new URL('/cources', request.url), 308);
  }

  // 1a-3. login, contact and the three policy pages are now real Next.js pages
  // (app/login, app/contact, app/privacypolicy, app/termsofuse, app/refundpolicy)
  // instead of static files in /public. Old .html links permanently redirect.
  const MOVED_FROM_HTML = {
    '/login.html': '/login',
    '/contact.html': '/contact',
    '/privacypolicy.html': '/privacypolicy',
    '/termsofuse.html': '/termsofuse',
    '/refundpolicy.html': '/refundpolicy',
  };
  if (MOVED_FROM_HTML[pathname]) {
    return NextResponse.redirect(new URL(MOVED_FROM_HTML[pathname], request.url), 308);
  }

  // 1b. ADMIN GATE — runs before ANYTHING else, including before the
  // student-auth block below and before any page/route code executes.
  // This covers both:
  //   - /admin and every nested page under it (the React admin panel UI)
  //   - /api/admin/... — every admin API route (products, users, push,
  //     reports, etc.) — NOT /api/admin-login or /api/admin-check, which
  //     must stay reachable so an admin can actually log in.
  //
  // Because this check happens here, at the edge, before Next.js ever
  // renders or streams a single byte of the admin page/route back to the
  // browser, there is no client-side state to fake — dev tools can't
  // bypass a check that runs before the browser receives anything. The
  // cookie itself is httpOnly (JS can't read/write it) and cryptographically
  // signed with a server-only secret (see lib/adminAuth.js), so even
  // manually adding a fake cookie via dev tools' Application tab fails
  // signature verification.
  const isAdminPage = effectivePath === '/admin' || effectivePath.startsWith('/admin/');
  const isAdminApi = pathname.startsWith('/api/admin/');

  // On the admin host, URLs without the /admin prefix are rewritten to it
  // (the browser keeps showing the short URL).
  const continueAdmin = () =>
    effectivePath !== pathname
      ? NextResponse.rewrite(new URL(effectivePath + request.nextUrl.search, request.url))
      : NextResponse.next();

  if (isAdminPage || isAdminApi) {
    const adminToken = request.cookies.get(ADMIN_COOKIE_NAME)?.value;
    const secret = process.env.ADMIN_SESSION_SECRET;

    const check = secret
      ? await verifyAdminTokenDetailed(adminToken, secret)
      : { valid: false, reason: 'no_secret_configured', payload: null };

    // Map the detailed reason to a human-scannable `result`, and split out
    // `invalid_signature` specifically as 'forged' — that's the case where
    // someone presented a cookie that does NOT match anything this server
    // ever issued, which is a real tampering/hacking signal, distinct from
    // a normal visitor with no cookie ('denied') or an admin whose session
    // simply timed out ('expired').
    let result;
    if (check.valid) {
      result = 'granted';
    } else if (check.reason === 'expired') {
      result = 'expired';
    } else if (check.reason === 'invalid_signature' || check.reason === 'malformed') {
      result = 'forged';
    } else {
      result = 'denied';
    }

    // Every single hit against an admin path gets logged — granted or
    // denied — so you have a full record of who accessed the panel, when,
    // and from where, including any attempt that got blocked. This fires
    // in the background via context.waitUntil so it never slows down the
    // actual response the browser is waiting on.
    const logPromise = logAdminAccess({
      request,
      path: pathname,
      method: request.method,
      result,
      email: check.payload?.email || null,
      success: check.valid,
      // A valid cookie hitting the gate reflects an already-established
      // session (issued earlier by /api/admin-login or /api/admin-check),
      // so it's labeled 'session_cookie' here regardless of how that
      // original session began.
      entryMethod: check.valid ? 'session_cookie' : null,
      reason: check.reason,
    });
    if (context?.waitUntil) {
      context.waitUntil(logPromise);
    }

    if (!check.valid) {
      if (isAdminApi) {
        // API routes get a clean 401 — no redirect, since a fetch() call
        // can't follow a page redirect meaningfully anyway.
        return NextResponse.json({ error: 'Unauthorized: Admin session required.' }, { status: 401 });
      }

      // Page routes: /admin itself IS the login gate, so let it through
      // to render the login form. Anything nested under /admin/ without
      // a valid session bounces back to /admin.
      if (effectivePath !== '/admin') {
        return NextResponse.redirect(isAdminHost ? hostUrl('/') : new URL('/admin', request.url));
      }
    }

    // Valid session (or already on the /admin gate page itself) — continue.
    return continueAdmin();
  }

  // 2. STRICTLY TARGET SECURE SUB-ROUTES ONLY
  // Check both extension-less paths and standard paths
  const isProtectedPath = 
    pathname.startsWith('/dashboard') || 
    pathname.startsWith('/profile') || 
    pathname.startsWith('/exam') ||
    pathname === '/training' || pathname.startsWith('/training/');

  if (isProtectedPath) {
    // Presence-only check. This used to also make a live fetch to
    // ${SUPABASE_URL}/auth/v1/user on every single request and delete the
    // cookie + redirect on ANY non-ok response -- not just a genuinely
    // invalid token, but also a timeout, a 5xx, or any transient blip from
    // Supabase's auth endpoint. On mobile, coming back from a backgrounded
    // tab (review.html -> back to /dashboard is a hard, cold navigation,
    // so this ran fresh every time) is exactly when a request like that is
    // most likely to hiccup -- radio waking up, TLS renegotiating, a
    // wifi<->cellular handoff -- which was bouncing perfectly-logged-in
    // students to /login for ~500ms before they got bounced straight back.
    //
    // No sensitive data is actually served on the strength of this check
    // passing: the dashboard shell itself renders nothing sensitive, and
    // every real data fetch (app/api/dashboard/*, app/api/exam/*, etc.)
    // independently re-verifies the session server-side via
    // supabase.auth.getUser()/getSession() before returning anything. The
    // client-side check in app/dashboard/layout.js is what actually kicks
    // a genuinely logged-out student to /login -- this gate here only
    // needs to stop someone with literally no cookie from ever loading the
    // shell in the first place.
    const token = request.cookies.get('cet_session_token')?.value;

    if (!token) {
      return NextResponse.redirect(new URL('/login', request.url));
    }
  }

  // Bypass backend API system routes completely
  if (pathname.startsWith('/api')) {
    return NextResponse.next();
  }

  // 3. 🛡️ CATCH-ALL ROUTING EXPLICIT SENTINEL (The 404 Blocker Rule)
  const validSystemRoutes = [
    '/',
    '/index', '/index.html',
    '/dashboard',
    '/training',
    '/exam', '/exam.html',
    '/review', '/review.html',
    '/login',
    '/not_live', '/not_live.html',
    '/profile',
    '/contact',
    '/purchase',
    '/pricing',
    // /cources is now an app-router page (app/cources/page.js). '/cources.html'
    // is deliberately NOT listed: if it were, the '.html' rewrite further down
    // would send /cources to the (deleted) static file and 404.
    '/cources',
    '/gallery',
    '/privacypolicy',
    '/termsofuse',
    '/refundpolicy',
    '/android/download',
    '/admin/cms',
    '/admin/cms-v2',
    '/admin/cms-v3',
    '/admin/cms/uploadmanually',
    '/admin/cms/overview',
    '/admin',
    '/admin/allprofiles',
    '/admin/users',
    '/admin/addadmin',
    '/admin/inquiries',
    '/admin/reports',
    '/admin/products',
    '/admin/addexamimages-v2',
    '/admin/overview',
    '/admin/leaderboard',
    '/auth.js',
    '/exam-engine.js'
  ];

  // Clean trailing slashes
  let normalizedPath = pathname;
  if (normalizedPath.endsWith('/') && normalizedPath.length > 1) {
    normalizedPath = normalizedPath.slice(0, -1);
  }

  // 🌟 FIX: Check if it matches our list or has a static asset extension (.css, .png, .js)
  const isExistingRoute =
    validSystemRoutes.includes(normalizedPath) ||
    normalizedPath.includes('.') ||
    // Individual batch pages built independently under /cources/<slug>
    // (e.g. /cources/mht-cet-2026) — always allowed through here; if the
    // matching .html file doesn't exist yet, Next.js's own 404 handles it.
    normalizedPath.startsWith('/cources/') ||
    // /dashboard is now an app-router OPTIONAL CATCH-ALL route
    // (app/dashboard/[[...slug]]/page.js), so it resolves URLs like
    // /dashboard/COURSE_xxx/SUB_yyy/CHAP_zzz itself. Without this, every
    // nested dashboard URL failed the validSystemRoutes exact-match check
    // above (only the bare '/dashboard' is listed) and got rewritten to
    // not_live.html before Next.js's router ever saw it. Same treatment
    // as /cources/ above — let it fall through to app-router resolution.
    normalizedPath.startsWith('/dashboard/') ||
    // TESTING ONLY: phone OMR checker (/qrchecker/android/<token>), opened from the
    // Admin -> Exams "OMR checker link" popup. The signed token in the URL is its permission.
    normalizedPath.startsWith('/qrchecker/');

  if (!isExistingRoute) {
    console.warn(`⚠️ Route intercepted and sent to 404 block canvas: ${normalizedPath}`);
    return NextResponse.rewrite(new URL('/not_live.html', request.url));
  }

  // If a clean URL has a matching static `<path>.html` in validSystemRoutes (e.g. /review, /exam, /not_live), serve it.
  // (/login, /contact and the policy pages are app-router pages now, so they are NOT rewritten.)
  // NOTE: /dashboard is excluded here on purpose -- it's now a real app-router
  // page (app/dashboard/page.js), not a static file, so it must never be
  // rewritten to dashboard.html even though older routes here still are.
  if (!normalizedPath.includes('.') && normalizedPath !== '/dashboard' && validSystemRoutes.includes(`${normalizedPath}.html`)) {
    return NextResponse.rewrite(new URL(`${normalizedPath}.html`, request.url));
  }

  // 🌟 Individual batch pages: /cources/<slug> now falls straight through
  // to Next.js's own app-router resolution, so it's served by
  // app/cources/<slug>/page.js instead of being rewritten to a static
  // file under public/cources/<slug>/index.html. (Previously this block
  // unconditionally rewrote to the public folder, which shadowed the
  // app-router page even when public/cources/<slug>/index.html didn't
  // exist — middleware here can't safely check file existence since it
  // runs on the edge runtime.)

  return NextResponse.next();
}

export const config = {
  // NOTE: previously this was '/((?!api|_next/static|_next/image|favicon.ico).*)',
  // which excluded ALL of /api — including /api/admin/* — from ever running
  // through this middleware. That meant the admin gate above could never
  // actually protect the admin API routes, only the page shell. Now only
  // /api/admin-login and /api/admin-check are explicitly carved out (they
  // must stay reachable to log in at all); every other /api/admin/* route
  // runs through the gate above.
  //
  // 🔧 SECURITY FIX: 'api/deploy-test' was previously excluded here too,
  // grouped in by copy-paste alongside api/exam / api/images / api/document.
  // Those three are legitimately public-facing routes that implement their
  // OWN auth internally (student session tokens). api/deploy-test and
  // api/deploy-test-v2, however, are admin CMS-push tooling with NO auth of
  // their own — excluding them meant anyone who found either URL could POST
  // to it directly with zero login and overwrite exam_question_data /
  // exam_answer_keys via the service-role key, and push arbitrary files
  // into the private GitHub content repo via GITHUB_TOKEN. Removing the
  // exclusion routes both through the same admin gate as every other
  // /api/admin/* route below. (Both routes also now double-check the admin
  // token themselves — see the top of each route.js — as defense-in-depth
  // in case this matcher is ever edited again without noticing.)
  matcher: [
    '/((?!api/admin-login|api/admin-check|api/exam|api/images|api/document|_next/static|_next/image|favicon.ico).*)',
  ],
};
