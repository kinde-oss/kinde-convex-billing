import { cronJobs } from "convex/server";
import { internal } from "./_generated/api.js";

const crons = cronJobs();

// Prune processed-webhook dedup records once they age past the retention window
// (see cleanupProcessedWebhooks in lib.ts) so the table cannot grow unbounded.
crons.interval(
  "cleanup processed webhooks",
  { hours: 6 },
  internal.lib.cleanupProcessedWebhooks,
  {},
);

export default crons;
