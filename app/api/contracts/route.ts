import { getServerSession } from 'next-auth';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { authOptions } from '@/lib/auth';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    
    if (!session?.user) {
      return NextResponse.json(null, { status: 401 });
    }

    // First ensure the user exists in our database
    const user = await prisma.user.findUnique({
      where: { id: session.user.id }
    });

    if (!user) {
      // Create the user if they don't exist
      await prisma.user.create({
        data: {
          id: session.user.id,
          email: session.user.email || '',
          name: session.user.name || '',
          image: session.user.image || '',
        }
      });
    }

    // Fetch contracts
    const contracts = await prisma.contract.findMany({
      where: {
        userId: session.user.id
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

    return NextResponse.json(contracts);
  } catch (error) {
    console.error('Error fetching contracts:', error);
    return NextResponse.json(
      { error: 'Failed to fetch contracts' },
      { status: 500 }
    );
  }
} 