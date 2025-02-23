import { handleAuth, handleCallback } from '@auth0/nextjs-auth0';
import { prisma } from '@/lib/db';

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
    return new Response(null, {
      status: 302,
      headers: {
        Location: '/auth/signin?error=' + encodeURIComponent(error.message)
      }
    });
  }
}); 