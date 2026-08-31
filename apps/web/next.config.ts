import type { NextConfig } from 'next';

const nextConfig: NextConfig = { transpilePackages: ['@knowledge-base/ui', '@knowledge-base/contracts'] };
export default nextConfig;
