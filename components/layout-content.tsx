'use client';

import { UserMenu } from "@/components/user-menu";

export function LayoutContent({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b">
        <div className="container mx-auto px-4 h-16 flex items-center justify-between">
          <h1 className="text-xl font-semibold">Contract Reviewer</h1>
          <UserMenu />
        </div>
      </header>
      <main className="flex-1">
        {children}
      </main>
    </div>
  );
} 