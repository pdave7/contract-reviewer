import { getSession } from '@auth0/nextjs-auth0';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  try {
    const res = new NextResponse();
    const session = await getSession(request, res);
    
    if (!session) {
      return NextResponse.json(null, { status: 401 });
    }
    
    const response = NextResponse.json(session.user);
    
    // Copy over the session cookie if it was updated
    const sessionCookie = res.headers.get('set-cookie');
    if (sessionCookie) {
      response.headers.set('set-cookie', sessionCookie);
    }
    
    return response;
  } catch (error) {
    console.error('Error getting session:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}