import { query, action, internalMutation } from "./_generated/server.js";
import { components } from "./_generated/api.js";
import { KindeBilling } from "../../src/client/index.js";
import { v } from "convex/values";

// These read wrappers forward straight to the component's reactive queries via
// `components.convexKindeBilling.lib.*`. They deliberately do NOT construct a
// `KindeBilling` client at module scope: the constructor validates
// KINDE_ISSUER_URL and throws when it is unset, so instantiating it here would
// break plain read queries (and tests) in any environment without the env var.
// Server-side actions that genuinely need the client (e.g. getPortalUrl below)
// construct it lazily inside their own handler.

export const getSubscription = query({
  args: { customerId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.runQuery(
      components.convexKindeBilling.lib.getSubscription,
      args,
    );
  },
});

export const hasActivePlan = query({
  args: { customerId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.runQuery(
      components.convexKindeBilling.lib.hasActivePlan,
      args,
    );
  },
});

export const getActivePlan = query({
  args: { customerId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.runQuery(
      components.convexKindeBilling.lib.getActivePlan,
      args,
    );
  },
});

export const hasFeature = query({
  args: { customerId: v.string(), featureKey: v.string() },
  handler: async (ctx, args) => {
    return await ctx.runQuery(
      components.convexKindeBilling.lib.hasFeature,
      args,
    );
  },
});

export const listBillingEvents = query({
  args: { customerId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.runQuery(
      components.convexKindeBilling.lib.listBillingEvents,
      args,
    );
  },
});

export const getUsage = query({
  args: { customerId: v.string(), meterId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.runQuery(components.convexKindeBilling.lib.getUsage, args);
  },
});

// Backs <ManageBillingButton>. The button (client-side) holds the logged-in
// user's Kinde access token — from your auth flow, e.g. `getToken()` /
// `useKindeAuth()` in the Kinde React SDK — and passes it here. This action then
// calls Kinde's Account API **server-side** via `kindeBilling.getPortalUrl`,
// which is why it is an action (not a query): it makes an outbound fetch and
// must never run in the browser where the token would be exposed to CORS.
export const getPortalUrl = action({
  args: {
    userAccessToken: v.string(),
    returnUrl: v.optional(v.string()),
    subNav: v.optional(v.string()),
  },
  returns: v.object({ url: v.string() }),
  handler: async (_ctx, args) => {
    // Construct the client lazily inside the handler: its constructor validates
    // KINDE_ISSUER_URL and throws if unset, so we keep it out of module scope
    // (which would break plain read queries / tests without the env var).
    const kindeBilling = new KindeBilling(components.convexKindeBilling, {
      KINDE_ISSUER_URL: process.env.KINDE_ISSUER_URL!,
    });
    const url = await kindeBilling.getPortalUrl(args.userAccessToken, {
      returnUrl: args.returnUrl,
      subNav: args.subNav,
    });
    return { url };
  },
});

// Internal, NOT public. simulateEvent dispatches straight into
// handleWebhookEvent with no JWT verification, so exposing it as a public
// mutation would let anyone with the deployment URL forge e.g.
// customer.plan_assigned and flip hasActivePlan to true without paying. As an
// internalMutation it is still usable for local demos from the Convex dashboard
// and `npx convex run example:simulateEvent`, but is not callable from clients.
export const simulateEvent = internalMutation({
  args: {
    eventType: v.string(),
    customerId: v.string(),
    customerType: v.union(v.literal("user"), v.literal("org")),
    planId: v.optional(v.string()),
    planName: v.optional(v.string()),
    agreementId: v.optional(v.string()),
    quantity: v.optional(v.number()),
    meterId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.runMutation(components.convexKindeBilling.lib.handleWebhookEvent, {
      // Clearly-simulated, unique dedup id so each demo dispatch is processed
      // (real deliveries prefer the signed event_id / jti from the verified JWT,
      // and fall back to the unsigned webhook-id header only if neither is set).
      webhookId: `sim_${crypto.randomUUID()}`,
      eventType: args.eventType,
      customerId: args.customerId,
      customerType: args.customerType,
      payload: JSON.stringify({ simulated: true, ts: Date.now() }),
      planId: args.planId,
      planName: args.planName,
      agreementId: args.agreementId,
      quantity: args.quantity,
      meterId: args.meterId,
    });
    return null;
  },
});
