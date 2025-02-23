import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export async function middleware(request: NextRequest) {
  // Allow Auth0 callback URLs
  if (request.nextUrl.pathname.startsWith('/api/auth')) {
    return NextResponse.next();
  }

  // Check for auth cookie
  const authCookie = request.cookies.get('appSession');
  const isAuthPage = request.nextUrl.pathname.startsWith('/auth');

  // If user is authenticated and tries to access auth pages, redirect to home
  if (authCookie && isAuthPage) {
    return NextResponse.redirect(new URL('/', request.url));
  }

  // If user is not authenticated and tries to access protected routes, redirect to login
  if (!authCookie && !isAuthPage) {
    return NextResponse.redirect(new URL('/auth/signin', request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    '/',
    '/api/analyze',
    '/api/contracts',
    '/auth/:path*',
    '/((?!api/auth|_next/static|_next/image|favicon.ico).*)',
  ],
}; 