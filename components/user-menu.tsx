'use client';

import { useUser } from '@auth0/nextjs-auth0/client';
import { User2 } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export function UserMenu() {
  const { user, isLoading } = useUser();
  const router = useRouter();

  const handleSignOut = () => {
    router.push('/api/auth/logout');
  };

  if (isLoading) {
    return (
      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted">
        <User2 className="h-4 w-4" />
      </div>
    );
  }

  if (!user) {
    return (
      <Link
        href="/api/auth/login"
        className="flex h-8 w-8 items-center justify-center rounded-full bg-muted hover:bg-muted/80"
      >
        <User2 className="h-4 w-4" />
      </Link>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-full bg-muted hover:bg-muted/80">
          {user.picture ? (
            <Image
              src={user.picture}
              alt={user.name || 'User avatar'}
              width={32}
              height={32}
              className="h-full w-full object-cover"
            />
          ) : (
            <User2 className="h-4 w-4" />
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>
          <div className="flex flex-col space-y-1">
            <p className="text-sm font-medium leading-none">{user.name}</p>
            <p className="text-xs leading-none text-muted-foreground">
              {user.email}
            </p>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={handleSignOut}>
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
} 