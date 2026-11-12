// Force Next.js server restart to load new Prisma client
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ['mailparser'],
  output: "standalone",
};

export default nextConfig;
