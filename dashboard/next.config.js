/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    const target = process.env.SCANNER_URL || "http://localhost:3000";
    return [
      {
        source: "/api/:path*",
        destination: `${target}/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;
