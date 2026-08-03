import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The Prisma driver adapter pulls in `pg`, which must stay a real Node
  // module rather than being bundled into the server build.
  serverExternalPackages: ['@prisma/client', '@prisma/adapter-pg', 'pg'],
};

export default nextConfig;
