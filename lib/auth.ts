import { AuthOptions } from 'next-auth';
import GoogleProvider from 'next-auth/providers/google';
import { PrismaAdapter } from '@auth/prisma-adapter';
import { prisma } from '@/lib/db';

export const authOptions: AuthOptions = {
  adapter: PrismaAdapter(prisma),
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
  ],
  session: {
    strategy: 'jwt',
  },
  pages: {
    signIn: '/auth/signin',
  },
  callbacks: {
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.sub!;
      }
      return session;
    },
    async redirect({ url, baseUrl }) {
      // Handle dynamic ports
      const currentUrl = typeof window !== 'undefined' ? window.location.origin : process.env.NEXTAUTH_URL || baseUrl;
      // Allows relative callback URLs
      if (url.startsWith("/")) {
        return `${currentUrl}${url}`;
      }
      // Allows callback URLs on the same origin
      else if (new URL(url).origin === currentUrl) {
        return url;
      }
      return currentUrl;
    },
  },
}; 