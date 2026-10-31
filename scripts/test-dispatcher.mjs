// Smoke test of api/record.js: unknown recorder -> 404, known recorder without secret -> 401
process.env.CRON_SECRET = "test-secret";
const { default: handler } = await import("../api/record.js");
const call = (src) => new Promise((resolve) => {
  const res = { status: (c) => ({ json: () => resolve(c) }) };
  handler({ query: src === undefined ? {} : { src }, headers: {} }, res);
});
const SRCS = ["gps", "stats", "extra", "schedule", "context", "cercanias", "regional", "env"];
for (const s of SRCS) if ((await call(s)) !== 401) throw new Error(`${s} should answer 401 without secret`);
for (const s of ["nope", "__proto__", "constructor", undefined]) if ((await call(s)) !== 404) throw new Error(`${s} should answer 404`);
console.log("dispatcher ok");
