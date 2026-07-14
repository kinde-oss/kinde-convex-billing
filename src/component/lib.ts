import { v } from "convex/values";
import {
  internalMutation,
  mutation,
  query,
} from "./_generated/server.js";

const statusValidator = v.union(
  v.literal("active"),
  v.literal("cancelled"),
  v.literal("past_due"),
  v.literal("unpaid"),
  v.literal("unknown"),
);

const subscriptionValidator = v.object({
  _id: v.id("subscriptions"),
  _creationTime: v.number(),
  customerId: v.string(),
  customerType: v.union(v.literal("user"), v.literal("org")),
  planId: v.optional(v.string()),
  planName: v.optional(v.string()),
  status: statusValidator,
  agreementId: v.optional(v.string()),
  currentPeriodEnd: v.optional(v.number()),
  cancelledAt: v.optional(v.number()),
  updatedAt: v.number(),
});

const billingEventValidator = v.object({
  _id: v.id("billingEvents"),
  _creationTime: v.number(),
  customerId: v.string(),
  eventType: v.string(),
  payload: v.string(),
  receivedAt: v.number(),
});

const usageRecordValidator = v.object({
  _id: v.id("usageRecords"),
  _creationTime: v.number(),
  customerId: v.string(),
  meterId: v.string(),
  quantity: v.number(),
  recordedAt: v.number(),
});

// ─── Queries ──────────────────────────────────────────────────────────────────

export const getSubscription = query({
  args: { customerId: v.string() },
  returns: v.union(v.null(), subscriptionValidator),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("subscriptions")
      .withIndex("by_customerId", (q) => q.eq("customerId", args.customerId))
      .first();
  },
});

export const hasActivePlan = query({
  args: { customerId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const sub = await ctx.db
      .query("subscriptions")
      .withIndex("by_customerId", (q) => q.eq("customerId", args.customerId))
      .first();
    return sub?.status === "active";
  },
});

export const getActivePlan = query({
  args: { customerId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      planId: v.optional(v.string()),
      planName: v.optional(v.string()),
      status: statusValidator,
      currentPeriodEnd: v.optional(v.number()),
    }),
  ),
  handler: async (ctx, args) => {
    const sub = await ctx.db
      .query("subscriptions")
      .withIndex("by_customerId", (q) => q.eq("customerId", args.customerId))
      .first();
    if (!sub) return null;
    return {
      planId: sub.planId,
      planName: sub.planName,
      status: sub.status,
      currentPeriodEnd: sub.currentPeriodEnd,
    };
  },
});

export const hasFeature = query({
  args: { customerId: v.string(), featureKey: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const sub = await ctx.db
      .query("subscriptions")
      .withIndex("by_customerId", (q) => q.eq("customerId", args.customerId))
      .first();
    if (!sub || sub.status !== "active") return false;
    // Match on planId OR planName, each optional: a customer may have only one
    // of the two set, so consulting planName only when planId exists would make
    // the documented "planId or planName contains featureKey" behaviour a lie.
    // Returns false only when inactive, or neither field is set, or neither
    // contains the featureKey.
    return (
      (sub.planId?.includes(args.featureKey) ?? false) ||
      (sub.planName?.toLowerCase().includes(args.featureKey.toLowerCase()) ??
        false)
    );
  },
});

export const listBillingEvents = query({
  args: {
    customerId: v.string(),
    limit: v.optional(v.number()),
  },
  returns: v.array(billingEventValidator),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("billingEvents")
      .withIndex("by_customerId", (q) => q.eq("customerId", args.customerId))
      .order("desc")
      .take(args.limit ?? 50);
  },
});

export const getUsage = query({
  args: {
    customerId: v.string(),
    meterId: v.string(),
    limit: v.optional(v.number()),
  },
  returns: v.array(usageRecordValidator),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("usageRecords")
      .withIndex("by_customerId_meterId", (q) =>
        q.eq("customerId", args.customerId).eq("meterId", args.meterId),
      )
      .order("desc")
      .take(args.limit ?? 100);
  },
});

// ─── Mutations ────────────────────────────────────────────────────────────────

export const handleWebhookEvent = mutation({
  args: {
    webhookId: v.string(),
    eventType: v.string(),
    customerId: v.string(),
    customerType: v.union(v.literal("user"), v.literal("org")),
    payload: v.string(),
    planId: v.optional(v.string()),
    planName: v.optional(v.string()),
    agreementId: v.optional(v.string()),
    currentPeriodEnd: v.optional(v.number()),
    quantity: v.optional(v.number()),
    meterId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Deduplicate by webhook ID before any write. Kinde retries billing
    // webhooks on non-200 (immediate, 5s, 30s, ...); without this every retry
    // would append a duplicate billingEvents audit row and re-apply the
    // subscription writes below. This check must precede the billingEvents
    // insert. The whole handler runs in a single mutation transaction, so the
    // read-then-insert is atomic.
    const seen = await ctx.db
      .query("processedWebhooks")
      .withIndex("by_webhookId", (q) => q.eq("webhookId", args.webhookId))
      .first();
    if (seen) return null;
    await ctx.db.insert("processedWebhooks", {
      webhookId: args.webhookId,
      processedAt: Date.now(),
    });

    await ctx.db.insert("billingEvents", {
      customerId: args.customerId,
      eventType: args.eventType,
      payload: args.payload,
      receivedAt: Date.now(),
    });

    switch (args.eventType) {
      case "customer.plan_assigned":
      case "customer.agreement_created":
      case "customer.payment_succeeded": {
        const existing = await ctx.db
          .query("subscriptions")
          .withIndex("by_customerId", (q) => q.eq("customerId", args.customerId))
          .first();
        if (existing) {
          await ctx.db.patch(existing._id, {
            status: "active",
            planId: args.planId ?? existing.planId,
            planName: args.planName ?? existing.planName,
            agreementId: args.agreementId ?? existing.agreementId,
            currentPeriodEnd: args.currentPeriodEnd ?? existing.currentPeriodEnd,
            updatedAt: Date.now(),
          });
        } else {
          await ctx.db.insert("subscriptions", {
            customerId: args.customerId,
            customerType: args.customerType,
            status: "active",
            planId: args.planId,
            planName: args.planName,
            agreementId: args.agreementId,
            currentPeriodEnd: args.currentPeriodEnd,
            updatedAt: Date.now(),
          });
        }
        break;
      }
      case "customer.plan_changed": {
        const existing = await ctx.db
          .query("subscriptions")
          .withIndex("by_customerId", (q) => q.eq("customerId", args.customerId))
          .first();
        if (existing) {
          await ctx.db.patch(existing._id, {
            planId: args.planId ?? existing.planId,
            planName: args.planName ?? existing.planName,
            agreementId: args.agreementId ?? existing.agreementId,
            currentPeriodEnd: args.currentPeriodEnd ?? existing.currentPeriodEnd,
            status: "active",
            updatedAt: Date.now(),
          });
        } else {
          // Upsert: plan_assigned may have been missed (webhook failure, or a
          // subscriber that predates install), so plan_changed must be able to
          // create the row rather than silently no-op and never track the plan.
          await ctx.db.insert("subscriptions", {
            customerId: args.customerId,
            customerType: args.customerType,
            status: "active",
            planId: args.planId,
            planName: args.planName,
            agreementId: args.agreementId,
            currentPeriodEnd: args.currentPeriodEnd,
            updatedAt: Date.now(),
          });
        }
        break;
      }
      case "customer.agreement_cancelled": {
        const existing = await ctx.db
          .query("subscriptions")
          .withIndex("by_customerId", (q) => q.eq("customerId", args.customerId))
          .first();
        if (existing) {
          await ctx.db.patch(existing._id, {
            status: "cancelled",
            cancelledAt: Date.now(),
            updatedAt: Date.now(),
          });
        }
        break;
      }
      case "customer.payment_failed":
      case "customer.invoice_overdue": {
        const existing = await ctx.db
          .query("subscriptions")
          .withIndex("by_customerId", (q) => q.eq("customerId", args.customerId))
          .first();
        if (existing) {
          await ctx.db.patch(existing._id, {
            status: args.eventType === "customer.invoice_overdue" ? "unpaid" : "past_due",
            updatedAt: Date.now(),
          });
        }
        break;
      }
      case "customer.meter_usage_updated": {
        if (args.meterId && args.quantity !== undefined) {
          await ctx.db.insert("usageRecords", {
            customerId: args.customerId,
            meterId: args.meterId,
            quantity: args.quantity,
            recordedAt: Date.now(),
          });
        }
        break;
      }
    }

    return null;
  },
});

// ─── Retention cleanup ──────────────────────────────────────────────────────
//
// The processedWebhooks table only exists to deduplicate retried deliveries, so
// rows are safe to discard once Kinde can no longer retry an event. Kinde
// retries a failed webhook delivery for up to ~24 hours; we keep dedup records
// for 7 days to comfortably cover that window (plus clock skew) before
// reclaiming the space. A cron (see crons.ts) invokes this on a schedule.
const WEBHOOK_DEDUP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// Bound the work per invocation so a large backlog never exceeds a single
// transaction's read/write limits; the cron reruns until the backlog drains.
const CLEANUP_BATCH_SIZE = 500;

export const cleanupProcessedWebhooks = internalMutation({
  args: { now: v.optional(v.number()) },
  returns: v.object({ deleted: v.number() }),
  handler: async (ctx, args) => {
    const cutoff = (args.now ?? Date.now()) - WEBHOOK_DEDUP_RETENTION_MS;
    const stale = await ctx.db
      .query("processedWebhooks")
      .withIndex("by_processedAt", (q) => q.lt("processedAt", cutoff))
      .take(CLEANUP_BATCH_SIZE);
    for (const row of stale) {
      await ctx.db.delete(row._id);
    }
    return { deleted: stale.length };
  },
});

// ─── Actions ──────────────────────────────────────────────────────────────────

