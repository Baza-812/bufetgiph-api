// /lib/handlers/health.js  (или pages/api/health.js — как у тебя устроено)
module.exports = async (req, res) => {
  const env = process.env.VERCEL_ENV || process.env.NODE_ENV || 'unknown'; // preview | production
  const ref = process.env.VERCEL_GIT_COMMIT_REF || 'unknown';              // ветка
  const sha = process.env.VERCEL_GIT_COMMIT_SHA || 'unknown';              // коммит

  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('x-api-env', env);
  res.setHeader('x-api-ref', ref);
  res.setHeader('x-api-sha', sha);
  res.setHeader('x-api-env', process.env.VERCEL_ENV || process.env.NODE_ENV || 'unknown');
  res.setHeader('x-api-ref', process.env.VERCEL_GIT_COMMIT_REF || 'unknown');
  res.setHeader('Cache-Control', 'no-store');

  res.status(200).json({
    ok: true,
    env,
    ref,
    sha,
    now: new Date().toISOString(),
  });
};
