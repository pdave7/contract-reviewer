import { handleAuth, handleCallback } from '@auth0/nextjs-auth0';
import { prisma } from '@/lib/db';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

const afterCallback = async (req: any, res: any, session: any) => {
  if (!session?.user?.sub) return session;

  try {
    await prisma.user.upsert({
      where: { id: session.user.sub },
      create: {
        id: session.user.sub,
        email: session.user.email || '',
        name: session.user.name || '',
        image: session.user.picture || ''
      },
      update: {
        email: session.user.email || '',
        name: session.user.name || '',
        image: session.user.picture || ''
      }
    });
  } catch (error) {
    console.error('Error upserting user:', error);
  }

  return session;
};

export const GET = handleAuth({
  callback: handleCallback({
    afterCallback
  }),
  onError(req: Request, error: Error) {
    console.error('Auth error:', error);
    const returnUrl = new URL('/auth/signin', process.env.AUTH0_BASE_URL || 'http://localhost:3000');
    returnUrl.searchParams.set('error', error.message);
    
    return NextResponse.redirect(returnUrl.toString());
  }
}); 