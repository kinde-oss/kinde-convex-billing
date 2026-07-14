import { cronJobs } from "convex/server";
import { internal } from "./_generated/api.js";

const crons = cronJobs();

// Prune processed-webhook dedup records once they age past the retention window
// (see cleanupProcessedWebhooks in lib.ts) so the table cannot grow unbounded.
// This interval only kicks off the drain: a run that fills a full batch
// reschedules itself immediately, so a large backlog clears without waiting for
// the next tick.
crons.interval(
  "cleanup processed webhooks",
  { hours: 6 },
  internal.lib.cleanupProcessedWebhooks,
  {},
);

export default crons;
