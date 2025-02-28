'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { signIn } from 'next-auth/react';
import { Button } from '@/components/ui/button';
import { AlertCircle } from 'lucide-react';
import Image from 'next/image';

export default function SignIn() {
  const searchParams = useSearchParams();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSignIn = async () => {
    try {
      setIsLoading(true);
      const callbackUrl = searchParams?.get('callbackUrl') || '/';
      await signIn('google', {
        callbackUrl,
      });
    } catch (err) {
      setError('An error occurred during sign in');
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background py-12 px-4 sm:px-6 lg:px-8 overscroll-x-auto">
      <div className="max-w-md w-full space-y-8">
        <div className="text-center">
          <h2 className="mt-6 text-3xl font-bold text-foreground">
            Welcome to Contract Reviewer
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Sign in to start analyzing your contracts
          </p>
        </div>

        {error && (
          <div className="p-4 rounded-lg bg-destructive/10 text-destructive flex items-center space-x-2">
            <AlertCircle className="h-5 w-5" />
            <p>{error}</p>
          </div>
        )}

        <div className="mt-8 space-y-4">
          <Button
            onClick={handleSignIn}
            className="w-full"
            variant="outline"
            disabled={isLoading}
          >
            <Image
              src="/google.svg"
              alt="Google"
              width={20}
              height={20}
              className="mr-2"
            />
            {isLoading ? 'Signing in...' : 'Continue with Google'}
          </Button>

          <p className="text-center text-sm text-muted-foreground">
            By signing in, you agree to our{' '}
            <a href="#" className="font-medium text-primary hover:text-primary/90">
              Terms of Service
            </a>{' '}
            and{' '}
            <a href="#" className="font-medium text-primary hover:text-primary/90">
              Privacy Policy
            </a>
          </p>
        </div>
      </div>
    </div>
  );
} 