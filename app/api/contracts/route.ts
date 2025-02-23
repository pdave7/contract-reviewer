import { getSession } from '@auth0/nextjs-auth0';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const res = new NextResponse();
    const session = await getSession(request, res);
    if (!session?.user?.sub) {
      return NextResponse.json(null, { status: 401 });
    }

    // First ensure the user exists in our database
    const user = await prisma.user.findUnique({
      where: { id: session.user.sub }
    });

    if (!user) {
      // Create the user if they don't exist
      await prisma.user.create({
        data: {
          id: session.user.sub,
          email: session.user.email || '',
          name: session.user.name || '',
          image: session.user.picture || ''
        }
      });
    }

    const contracts = await prisma.contract.findMany({
      where: {
        userId: session.user.sub
      },
      orderBy: {
        createdAt: 'desc'
      },
      select: {
        id: true,
        name: true,
        status: true,
        analysis: true,
        summary: true,
        createdAt: true,
        fileType: true
      }
    });

    const response = NextResponse.json(contracts);
    
    // Copy over the session cookie if it was updated
    const sessionCookie = res.headers.get('set-cookie');
    if (sessionCookie) {
      response.headers.set('set-cookie', sessionCookie);
    }
    
    return response;
  } catch (error) {
    console.error('Error fetching contracts:', error);
    return NextResponse.json(
      { error: 'Failed to fetch contracts' },
      { status: 500 }
    );
  }
} 