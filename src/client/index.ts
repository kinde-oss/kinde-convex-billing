import { httpActionGeneric } from "convex/server";
import * as jose from "jose";
import type { GenericActionCtx, GenericDataModel } from "convex/server";
import type { ComponentApi } from "../component/_generated/component.js";

export type KindeBillingOptions = {
  KINDE_ISSUER_URL: string;
};

function formatPlanName(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  return raw
    .replace(/^customer_/, "")
    .replace(/_plan$/, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export class KindeBilling {
  webhookHandler: ReturnType<typeof httpActionGeneric>;

  constructor(
    private component: ComponentApi,
    private options: KindeBillingOptions,
  ) {
    const component_ = component;
    const domain = options.KINDE_ISSUER_URL;

    // Validate the issuer before building any URL, so a missing config throws a
    // clear error instead of producing "undefined/.well-known/jwks.json" and
    // crashing module analysis at deploy time.
    if (!domain) {
      throw new Error(
        "KindeBilling: KINDE_ISSUER_URL is required to construct the client",
      );
    }

    // Create the JWKS client once, keyed by the (validated) issuer domain, so
    // jose's built-in key cache is reused across requests instead of being
    // rebuilt (and refetched) on every webhook. Instantiating it inside the
    // handler refetched Kinde's keys on every delivery, which timed out the
    // first delivery with a ~5s AbortError and only succeeded on Kinde's retry.
    const JWKS: ReturnType<typeof jose.createRemoteJWKSet> =
      jose.createRemoteJWKSet(new URL(`${domain}/.well-known/jwks.json`));

    this.webhookHandler = httpActionGeneric(async (ctx, request) => {
      const token = await request.text();
      if (!token) {
        return new Response(JSON.stringify({ error: "Missing token" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      let payload: Record<string, unknown>;
      try {
        // Verify the signature against the tenant's JWKS only — do NOT assert an
        // `iss` claim. Kinde webhook JWTs do not carry an `iss` claim, so
        // `jwtVerify(token, JWKS, { issuer })` fails on every real webhook with
        // "missing required iss claim". The webhook is already tenant-bound by
        // the JWKS URL we fetch keys from (derived from this deployment's
        // KINDE_ISSUER_URL), so signature verification alone is the correct
        // binding here. `iss` checks belong on access tokens, not on webhooks.
        const result = await jose.jwtVerify(token, JWKS);
        payload = result.payload as Record<string, unknown>;
      } catch (err) {
        console.error("Kinde billing webhook JWT verification failed:", err);
        return new Response(JSON.stringify({ error: "Invalid token" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Derive a stable dedup id, preferring SIGNED sources. The payload
      // `event_id` and JWT `jti` live inside the JWT we just verified, so they
      // are trustworthy. The `webhook-id` request header is unsigned and
      // attacker-controlled — on a replayed valid JWT an attacker could set a
      // fresh header value to slip a duplicate past dedup — so it must never
      // override a signed identifier and is only a last resort. There is
      // deliberately no Date.now() fallback: an event with none of these cannot
      // be deduplicated, and minting a fresh id per retry would make every retry
      // look new and defeat idempotency (mirrors kinde-convex-sync's decision).
      const eventId = payload.event_id;
      const jti = payload.jti;
      const headerId = request.headers.get("webhook-id");
      let webhookId: string;
      if (typeof eventId === "string" && eventId) {
        webhookId = eventId;
      } else if (typeof eventId === "number") {
        webhookId = `${eventId}`;
      } else if (typeof jti === "string" && jti) {
        webhookId = jti;
      } else if (headerId) {
        webhookId = headerId;
      } else {
        return new Response(
          JSON.stringify({ error: "Missing webhook identifier" }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }

      const eventType = (payload.type || payload.event_type) as string;
      const data = payload.data as Record<string, unknown> | undefined;

      if (!eventType || !data) {
        return new Response(JSON.stringify({ error: "Invalid payload" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      const customerId =
        (data.org_code as string) ||
        (data.customer_id as string) ||
        (data.user_id as string) ||
        "";
      const customerType = (data.org_code as string) ? "org" : "user";

      if (!customerId) {
        return new Response(JSON.stringify({ error: "Missing customer ID" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      const plan = data.plan as Record<string, unknown> | undefined;
      const rawPlanId =
        (data.plan_id as string) ||
        (plan?.code as string) ||
        (plan?.key as string) ||
        undefined;
      const planName = formatPlanName(rawPlanId);

      const rawPeriodEnd = data.invoice_due_on || data.next_billing_date;
      const currentPeriodEnd = rawPeriodEnd
        ? new Date((rawPeriodEnd as string).replace(/([+-]\d{2})$/, "$1:00")).getTime() || undefined
        : undefined;

      await ctx.runMutation(component_.lib.handleWebhookEvent, {
        webhookId,
        eventType,
        customerId,
        customerType: customerType as "user" | "org",
        payload: JSON.stringify(payload),
        planId: rawPlanId,
        planName,
        agreementId: (data.agreement_id as string) || undefined,
        currentPeriodEnd,
        meterId: (data.meter_id as string) || undefined,
        // Use a typeof check, not `|| undefined`: a valid metered quantity of 0
        // is falsy and would otherwise be dropped.
        quantity:
          typeof data.quantity === "number" ? data.quantity : undefined,
      });

      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
  }

  getCheckoutUrl(args: {
    clientId: string;
    redirectUri: string;
    planKey?: string;
    pricingTableKey?: string;
    isCreateOrg?: boolean;
  }): string {
    const domain = this.options.KINDE_ISSUER_URL;
    const params = new URLSearchParams({
      response_type: "code",
      client_id: args.clientId,
      redirect_uri: args.redirectUri,
      scope: "openid profile email",
    });
    if (args.planKey) params.set("plan_interest", args.planKey);
    if (args.pricingTableKey) params.set("pricing_table_key", args.pricingTableKey);
    if (args.isCreateOrg) params.set("is_create_org", "true");
    return `${domain}/oauth2/auth?${params.toString()}`;
  }

  /**
   * Get a self-serve portal URL using the logged-in user's Kinde access token.
   * Call this client-side.
   *
   * @example
   * const url = await kindeBilling.getPortalUrl(userAccessToken, {
   *   returnUrl: "https://yourapp.com/settings",
   * });
   * window.location.href = url;
   */
  async getPortalUrl(
    userAccessToken: string,
    options?: { returnUrl?: string; subNav?: string },
  ): Promise<string> {
    const params = new URLSearchParams();
    if (options?.returnUrl) params.set("return_url", options.returnUrl);
    if (options?.subNav) params.set("sub_nav", options.subNav);
    const url = `${this.options.KINDE_ISSUER_URL}/account_api/v1/portal_link${params.toString() ? "?" + params.toString() : ""}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${userAccessToken}` },
    });
    if (!res.ok) {
      throw new Error(`Failed to get portal link: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as { url: string };
    return data.url;
  }

  async getSubscription(ctx: RunQueryCtx, args: { customerId: string }) {
    return await ctx.runQuery(this.component.lib.getSubscription, args);
  }

  async hasActivePlan(ctx: RunQueryCtx, args: { customerId: string }): Promise<boolean> {
    return await ctx.runQuery(this.component.lib.hasActivePlan, args);
  }

  async getActivePlan(ctx: RunQueryCtx, args: { customerId: string }) {
    return await ctx.runQuery(this.component.lib.getActivePlan, args);
  }

  async hasFeature(ctx: RunQueryCtx, args: { customerId: string; featureKey: string }): Promise<boolean> {
    return await ctx.runQuery(this.component.lib.hasFeature, args);
  }

  async listBillingEvents(ctx: RunQueryCtx, args: { customerId: string; limit?: number }) {
    return await ctx.runQuery(this.component.lib.listBillingEvents, args);
  }

  async getUsage(ctx: RunQueryCtx, args: { customerId: string; meterId: string; limit?: number }) {
    return await ctx.runQuery(this.component.lib.getUsage, args);
  }
}

type RunQueryCtx = {
  runQuery: GenericActionCtx<GenericDataModel>["runQuery"];
};
