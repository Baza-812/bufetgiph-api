// /lib/handlers/health.js
module.exports = async (req, res) => {
  const env = process.env.VERCEL_ENV || process.env.NODE_ENV || 'unknown';
  const ref = process.env.VERCEL_GIT_COMMIT_REF || 'unknown';
  const sha = process.env.VERCEL_GIT_COMMIT_SHA || 'unknown';
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    ok: true,
    env,
    ref,
    sha,
    now: new Date().toISOString(),
  });
};
