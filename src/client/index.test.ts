import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { KindeBilling } from "./index.js";
import { components } from "./setup.test.js";
import * as jose from "jose";

// Mock jose so we can drive JWT verification outcomes without real keys, and
// count how often the JWKS client is created.
vi.mock("jose", () => ({
  createRemoteJWKSet: vi.fn(() => vi.fn()),
  jwtVerify: vi.fn(),
}));

const mockJwtVerify = vi.mocked(jose.jwtVerify);
const mockCreateRemoteJWKSet = vi.mocked(jose.createRemoteJWKSet);

// The webhook handler's underlying function, invoked directly with a mock ctx
// so we can assert on the mutation it dispatches (mirrors how convex-test's
// `fetch` calls the handler with an injected ctx).
type MockCtx = { runMutation: ReturnType<typeof vi.fn> };
type WebhookHandler = (ctx: MockCtx, request: Request) => Promise<Response>;

function getHandler(client: KindeBilling): WebhookHandler {
  return (client.webhookHandler as unknown as { _handler: WebhookHandler })
    ._handler;
}

function makeClient() {
  return new KindeBilling(components.convexKindeBilling, {
    KINDE_ISSUER_URL: "https://example.kinde.com",
  });
}

function postRequest(body: string, headers?: Record<string, string>) {
  return new Request("https://deploy.convex.site/webhooks/kinde/billing", {
    method: "POST",
    body,
    headers,
  });
}

describe("KindeBilling client", () => {
  beforeEach(() => {
    mockCreateRemoteJWKSet.mockClear();
  });

  test("instantiates with a valid domain and creates the JWKS client once", () => {
    const client = makeClient();
    expect(client).toBeDefined();
    expect(client.webhookHandler).toBeDefined();
    expect(mockCreateRemoteJWKSet).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["undefined", undefined],
    ["empty", ""],
  ])("throws a typed error when the domain is %s", (_label, domain) => {
    expect(
      () =>
        new KindeBilling(components.convexKindeBilling, {
          KINDE_ISSUER_URL: domain as unknown as string,
        }),
    ).toThrow(
      "KindeBilling: KINDE_ISSUER_URL is required to construct the client",
    );
    expect(mockCreateRemoteJWKSet).not.toHaveBeenCalled();
  });

  test("creates the JWKS client once in the constructor, not per request", async () => {
    mockJwtVerify.mockResolvedValue({
      payload: {
        jti: "evt_once",
        type: "customer.plan_assigned",
        data: { customer_id: "customer_abc" },
      },
    } as unknown as Awaited<ReturnType<typeof jose.jwtVerify>>);
    const handler = getHandler(makeClient());
    const ctx: MockCtx = { runMutation: vi.fn().mockResolvedValue(null) };
    await handler(ctx, postRequest("some.jwt.token"));
    await handler(ctx, postRequest("some.jwt.token"));
    // Two deliveries, but the JWKS client was only built once — at construction.
    expect(mockCreateRemoteJWKSet).toHaveBeenCalledTimes(1);
  });
});

describe("KindeBilling webhookHandler", () => {
  beforeEach(() => {
    mockJwtVerify.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("returns 400 when the token body is missing", async () => {
    const ctx: MockCtx = { runMutation: vi.fn().mockResolvedValue(null) };
    const res = await getHandler(makeClient())(ctx, postRequest(""));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Missing token" });
    expect(mockJwtVerify).not.toHaveBeenCalled();
    expect(ctx.runMutation).not.toHaveBeenCalled();
  });

  test("returns 401 when JWT verification fails", async () => {
    mockJwtVerify.mockRejectedValue(new Error("bad signature"));
    const ctx: MockCtx = { runMutation: vi.fn().mockResolvedValue(null) };
    const res = await getHandler(makeClient())(ctx, postRequest("some.jwt.token"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid token" });
    expect(ctx.runMutation).not.toHaveBeenCalled();
  });

  test("verifies against the JWKS only, with no issuer assertion", async () => {
    mockJwtVerify.mockResolvedValue({
      payload: {
        jti: "evt_iss",
        type: "customer.plan_assigned",
        data: { customer_id: "customer_abc" },
      },
    } as unknown as Awaited<ReturnType<typeof jose.jwtVerify>>);
    const ctx: MockCtx = { runMutation: vi.fn().mockResolvedValue(null) };
    await getHandler(makeClient())(ctx, postRequest("some.jwt.token"));
    // Kinde webhook JWTs carry no `iss` claim, so we must call jwtVerify with
    // (token, JWKS) and NO issuer option — asserting an issuer would reject
    // every real webhook with "missing required iss claim".
    expect(mockJwtVerify).toHaveBeenCalledWith(
      "some.jwt.token",
      expect.anything(),
    );
    expect(mockJwtVerify.mock.calls[0]).toHaveLength(2);
  });

  test("returns 400 and dispatches nothing when no webhook identifier is present", async () => {
    mockJwtVerify.mockResolvedValue({
      payload: {
        // No webhook-id header, no jti, no event_id.
        type: "customer.plan_assigned",
        data: { customer_id: "customer_abc" },
      },
    } as unknown as Awaited<ReturnType<typeof jose.jwtVerify>>);
    const ctx: MockCtx = { runMutation: vi.fn().mockResolvedValue(null) };
    const res = await getHandler(makeClient())(ctx, postRequest("some.jwt.token"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Missing webhook identifier" });
    expect(ctx.runMutation).not.toHaveBeenCalled();
  });

  test("derives webhookId from jti and dispatches the mutation", async () => {
    mockJwtVerify.mockResolvedValue({
      payload: {
        jti: "evt_ok",
        type: "customer.plan_assigned",
        data: { customer_id: "customer_abc", plan_id: "customer_pro_plan" },
      },
    } as unknown as Awaited<ReturnType<typeof jose.jwtVerify>>);
    const ctx: MockCtx = { runMutation: vi.fn().mockResolvedValue(null) };
    const res = await getHandler(makeClient())(ctx, postRequest("some.jwt.token"));
    expect(res.status).toBe(200);
    expect(ctx.runMutation).toHaveBeenCalledTimes(1);
    const [, args] = ctx.runMutation.mock.calls[0];
    expect(args).toMatchObject({
      webhookId: "evt_ok",
      eventType: "customer.plan_assigned",
      customerId: "customer_abc",
      customerType: "user",
      planId: "customer_pro_plan",
      planName: "Pro",
    });
  });

  test("falls back to event_id as webhookId when jti is absent", async () => {
    mockJwtVerify.mockResolvedValue({
      payload: {
        event_id: 987654,
        type: "customer.plan_assigned",
        data: { customer_id: "customer_abc" },
      },
    } as unknown as Awaited<ReturnType<typeof jose.jwtVerify>>);
    const ctx: MockCtx = { runMutation: vi.fn().mockResolvedValue(null) };
    await getHandler(makeClient())(ctx, postRequest("some.jwt.token"));
    expect(ctx.runMutation).toHaveBeenCalledTimes(1);
    const [, args] = ctx.runMutation.mock.calls[0];
    expect(args).toMatchObject({ webhookId: "987654", customerId: "customer_abc" });
  });

  test("prefers a signed jti over the unsigned webhook-id header", async () => {
    mockJwtVerify.mockResolvedValue({
      payload: {
        jti: "evt_from_jti",
        type: "customer.plan_assigned",
        data: { customer_id: "customer_abc" },
      },
    } as unknown as Awaited<ReturnType<typeof jose.jwtVerify>>);
    const ctx: MockCtx = { runMutation: vi.fn().mockResolvedValue(null) };
    await getHandler(makeClient())(
      ctx,
      postRequest("some.jwt.token", { "webhook-id": "hdr_123" }),
    );
    // The header is attacker-controllable on a replayed JWT, so a signed jti
    // must win — never let the unsigned header override it and bypass dedup.
    expect(ctx.runMutation).toHaveBeenCalledTimes(1);
    const [, args] = ctx.runMutation.mock.calls[0];
    expect(args).toMatchObject({ webhookId: "evt_from_jti" });
  });

  test("uses the webhook-id header only when no signed id is present", async () => {
    mockJwtVerify.mockResolvedValue({
      payload: {
        // No event_id, no jti — the unsigned header is the last-resort fallback.
        type: "customer.plan_assigned",
        data: { customer_id: "customer_abc" },
      },
    } as unknown as Awaited<ReturnType<typeof jose.jwtVerify>>);
    const ctx: MockCtx = { runMutation: vi.fn().mockResolvedValue(null) };
    await getHandler(makeClient())(
      ctx,
      postRequest("some.jwt.token", { "webhook-id": "hdr_123" }),
    );
    expect(ctx.runMutation).toHaveBeenCalledTimes(1);
    const [, args] = ctx.runMutation.mock.calls[0];
    expect(args).toMatchObject({ webhookId: "hdr_123" });
  });

  test("dispatches a metered quantity of 0 (not dropped as falsy)", async () => {
    mockJwtVerify.mockResolvedValue({
      payload: {
        jti: "evt_zero",
        type: "customer.meter_usage_updated",
        data: { customer_id: "customer_abc", meter_id: "api_calls", quantity: 0 },
      },
    } as unknown as Awaited<ReturnType<typeof jose.jwtVerify>>);
    const ctx: MockCtx = { runMutation: vi.fn().mockResolvedValue(null) };
    await getHandler(makeClient())(ctx, postRequest("some.jwt.token"));
    expect(ctx.runMutation).toHaveBeenCalledTimes(1);
    const [, args] = ctx.runMutation.mock.calls[0];
    expect(args.meterId).toBe("api_calls");
    expect(args.quantity).toBe(0);
  });

  test("returns 400 for a malformed payload (missing type/data)", async () => {
    mockJwtVerify.mockResolvedValue({
      payload: { jti: "evt_bad" },
    } as unknown as Awaited<ReturnType<typeof jose.jwtVerify>>);
    const ctx: MockCtx = { runMutation: vi.fn().mockResolvedValue(null) };
    const res = await getHandler(makeClient())(ctx, postRequest("some.jwt.token"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid payload" });
    expect(ctx.runMutation).not.toHaveBeenCalled();
  });

  test("returns 400 when the customer id is missing", async () => {
    mockJwtVerify.mockResolvedValue({
      payload: {
        jti: "evt_no_customer",
        type: "customer.plan_assigned",
        data: {},
      },
    } as unknown as Awaited<ReturnType<typeof jose.jwtVerify>>);
    const ctx: MockCtx = { runMutation: vi.fn().mockResolvedValue(null) };
    const res = await getHandler(makeClient())(ctx, postRequest("some.jwt.token"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Missing customer ID" });
    expect(ctx.runMutation).not.toHaveBeenCalled();
  });
});
