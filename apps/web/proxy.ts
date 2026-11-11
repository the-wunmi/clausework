import { type NextRequest, NextResponse } from 'next/server';

/**
 * Sends a browser without a session to sign in before it loads an owner page. The API is what
 * enforces access; this only spares a page that would load and then bounce. Portal links, the
 * PayPal return page and sign-in itself are open.
 */
export function proxy(request: NextRequest) {
  if (request.cookies.has('cw_session')) return NextResponse.next();
  const url = request.nextUrl.clone();
  url.pathname = '/login';
  url.search = `?next=${encodeURIComponent(request.nextUrl.pathname + request.nextUrl.search)}`;
  return NextResponse.redirect(url);
}

export const config = {
  // Everything except the API (it answers 401 itself), Next's assets, the portal and sign-in.
  matcher: ['/((?!api/|_next/|p/|login|icon.svg|favicon.ico).*)'],
};
