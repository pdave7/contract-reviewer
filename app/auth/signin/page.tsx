'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { AlertCircle } from 'lucide-react';

export default function SignIn() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isLoading, setIsLoading] = useState(false);
  const error = searchParams.get('error');
  const returnTo = searchParams.get('returnTo');

  const handleSignIn = () => {
    setIsLoading(true);
    const loginUrl = returnTo 
      ? `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`
      : '/api/auth/login';
    window.location.href = loginUrl;
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background py-12 px-4 sm:px-6 lg:px-8">
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
            <p>There was an error signing in. Please try again.</p>
          </div>
        )}

        <div className="mt-8">
          <Button
            onClick={handleSignIn}
            className="w-full"
            size="lg"
            disabled={isLoading}
          >
            {isLoading ? 'Signing in...' : 'Sign in with Auth0'}
          </Button>
        </div>

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
  );
} 