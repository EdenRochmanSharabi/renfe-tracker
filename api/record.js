// One serverless function for every recorder (Vercel Hobby allows 12 functions per deployment).
// vercel.json rewrites /api/record-<src> to /api/record?src=<src>, so the cron URLs do not change.
// The recorder code lives in lib/ (not counted as functions); each module keeps its own secret check.
import gps from "../lib/record-gps.js";
import stats from "../lib/record-stats.js";
import extra from "../lib/record-extra.js";
import schedule from "../lib/record-schedule.js";
import context from "../lib/record-context.js";
import cercanias from "../lib/record-cercanias.js";
import regional from "../lib/record-regional.js";
import env from "../lib/record-env.js";

const RECORDERS = { gps, stats, extra, schedule, context, cercanias, regional, env };

export default function handler(req, res) {
  const run = Object.hasOwn(RECORDERS, req.query?.src) ? RECORDERS[req.query.src] : null;
  if (!run) return res.status(404).json({ error: "unknown recorder" });
  return run(req, res);
}
