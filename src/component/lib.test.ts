import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema.js";

const modules = import.meta.glob("./**/*.ts");

test("getSubscription returns null for unknown customer", async () => {
  const t = convexTest(schema, modules);
  const result = await t.query(api.lib.getSubscription, {
    customerId: "user_test123",
  });
  expect(result).toBe(null);
});

test("hasActivePlan returns false for unknown customer", async () => {
  const t = convexTest(schema, modules);
  const result = await t.query(api.lib.hasActivePlan, {
    customerId: "user_test123",
  });
  expect(result).toBe(false);
});

test("handleWebhookEvent creates subscription on plan_assigned", async () => {
  const t = convexTest(schema, modules);
  await t.mutation(api.lib.handleWebhookEvent, {
    webhookId: "wh_plan_assigned_1",
    eventType: "customer.plan_assigned",
    customerId: "user_test123",
    customerType: "user",
    payload: "{}",
    planId: "plan_pro",
    planName: "Pro",
  });
  const result = await t.query(api.lib.hasActivePlan, {
    customerId: "user_test123",
  });
  expect(result).toBe(true);
});

test("handleWebhookEvent cancels subscription on agreement_cancelled", async () => {
  const t = convexTest(schema, modules);
  await t.mutation(api.lib.handleWebhookEvent, {
    webhookId: "wh_cancel_assigned_1",
    eventType: "customer.plan_assigned",
    customerId: "user_test123",
    customerType: "user",
    payload: "{}",
    planId: "plan_pro",
    planName: "Pro",
  });
  await t.mutation(api.lib.handleWebhookEvent, {
    webhookId: "wh_cancel_1",
    eventType: "customer.agreement_cancelled",
    customerId: "user_test123",
    customerType: "user",
    payload: "{}",
  });
  const result = await t.query(api.lib.hasActivePlan, {
    customerId: "user_test123",
  });
  expect(result).toBe(false);
});

test("listBillingEvents returns events for customer", async () => {
  const t = convexTest(schema, modules);
  await t.mutation(api.lib.handleWebhookEvent, {
    webhookId: "wh_payment_succeeded_1",
    eventType: "customer.payment_succeeded",
    customerId: "user_test123",
    customerType: "user",
    payload: "{}",
  });
  const events = await t.query(api.lib.listBillingEvents, {
    customerId: "user_test123",
  });
  expect(events.length).toBe(1);
  expect(events[0].eventType).toBe("customer.payment_succeeded");
});

test("same webhookId delivered twice writes exactly one billing event (dedup)", async () => {
  const t = convexTest(schema, modules);
  const delivery = {
    webhookId: "wh_dupe_1",
    eventType: "customer.payment_succeeded",
    customerId: "user_dupe",
    customerType: "user" as const,
    payload: "{}",
  };
  await t.mutation(api.lib.handleWebhookEvent, delivery);
  // Retry with the same webhookId is a no-op success.
  await t.mutation(api.lib.handleWebhookEvent, delivery);
  const events = await t.query(api.lib.listBillingEvents, {
    customerId: "user_dupe",
  });
  expect(events).toHaveLength(1);
});

test("plan_changed with no existing subscription creates the row (upsert)", async () => {
  const t = convexTest(schema, modules);
  await t.mutation(api.lib.handleWebhookEvent, {
    webhookId: "wh_changed_upsert",
    eventType: "customer.plan_changed",
    customerId: "user_upsert",
    customerType: "user",
    payload: "{}",
    planId: "customer_pro_plan",
    planName: "Pro",
  });
  const sub = await t.query(api.lib.getSubscription, {
    customerId: "user_upsert",
  });
  expect(sub).not.toBeNull();
  expect(sub?.status).toBe("active");
  expect(sub?.planName).toBe("Pro");
});

test("hasFeature matches on planName when planId is absent", async () => {
  const t = convexTest(schema, modules);
  await t.mutation(api.lib.handleWebhookEvent, {
    webhookId: "wh_feat_planname",
    eventType: "customer.plan_assigned",
    customerId: "user_feat1",
    customerType: "user",
    payload: "{}",
    // planId intentionally omitted — only planName is set.
    planName: "Pro",
  });
  const result = await t.query(api.lib.hasFeature, {
    customerId: "user_feat1",
    featureKey: "pro",
  });
  expect(result).toBe(true);
});

test("hasFeature returns false when the subscription is not active", async () => {
  const t = convexTest(schema, modules);
  await t.mutation(api.lib.handleWebhookEvent, {
    webhookId: "wh_feat_assigned",
    eventType: "customer.plan_assigned",
    customerId: "user_feat2",
    customerType: "user",
    payload: "{}",
    planId: "customer_pro_plan",
    planName: "Pro",
  });
  await t.mutation(api.lib.handleWebhookEvent, {
    webhookId: "wh_feat_cancel",
    eventType: "customer.agreement_cancelled",
    customerId: "user_feat2",
    customerType: "user",
    payload: "{}",
  });
  const result = await t.query(api.lib.hasFeature, {
    customerId: "user_feat2",
    featureKey: "pro",
  });
  expect(result).toBe(false);
});

test("hasFeature returns false when neither planId nor planName matches", async () => {
  const t = convexTest(schema, modules);
  await t.mutation(api.lib.handleWebhookEvent, {
    webhookId: "wh_feat_nomatch",
    eventType: "customer.plan_assigned",
    customerId: "user_feat3",
    customerType: "user",
    payload: "{}",
    planId: "customer_basic_plan",
    planName: "Basic",
  });
  const result = await t.query(api.lib.hasFeature, {
    customerId: "user_feat3",
    featureKey: "pro",
  });
  expect(result).toBe(false);
});

test("cleanupProcessedWebhooks prunes rows older than the retention window", async () => {
  const t = convexTest(schema, modules);
  await t.mutation(api.lib.handleWebhookEvent, {
    webhookId: "wh_retention",
    eventType: "customer.payment_succeeded",
    customerId: "user_retention",
    customerType: "user",
    payload: "{}",
  });
  // Freshly processed row is within the 7-day window and must be kept.
  const noop = await t.mutation(internal.lib.cleanupProcessedWebhooks, {
    now: Date.now(),
  });
  expect(noop.deleted).toBe(0);
  // 8 days later the dedup record is past the retention window.
  const eightDaysLater = Date.now() + 8 * 24 * 60 * 60 * 1000;
  const pruned = await t.mutation(internal.lib.cleanupProcessedWebhooks, {
    now: eightDaysLater,
  });
  expect(pruned.deleted).toBe(1);
});
