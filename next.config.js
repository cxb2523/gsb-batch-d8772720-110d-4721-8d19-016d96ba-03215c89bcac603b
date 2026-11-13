/* @influxdata/giraffe is a browser-only library and references the `self`
 * global at module load. Next.js evaluates modules during build-time page
 * data collection where `self` is undefined, so provide a minimal alias for
 * that phase. In the browser the native `self` is used unchanged.
 */
if (typeof globalThis.self === 'undefined') {
  globalThis.self = globalThis
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return {
      beforeFiles: [
        {
          source: '/api/:endpoint*',
          destination: `${process.env.API_URL}/:endpoint*`, // The :path parameter isn't used here so will be automatically passed in the query
        },
      ]
    }
  },
}

module.exports = nextConfig
