import { httpRouter, httpActionGeneric } from "convex/server";
import type { GenericActionCtx, GenericDataModel } from "convex/server";
import { components } from "./_generated/api";
import { KindeBilling } from "../../src/client/index.js";

// Memoized lazy singleton. Two constraints have to hold at once:
//   - Lazy: the KindeBilling constructor validates KINDE_ISSUER_URL and throws
//     if it is unset. Constructing at module scope would make that throw crash
//     module evaluation at deploy time; constructing on first request instead
//     surfaces the misconfig as a request-time error.
//   - Cached: the constructor builds the JWKS client exactly once (the human
//     reviewer's blocking fix — jose's key cache must be reused across
//     deliveries, not rebuilt per request). So we construct at most once and
//     reuse the same instance (and its single JWKS client) for every delivery.
let cached: KindeBilling | undefined;
function getKindeBilling(): KindeBilling {
  if (!cached) {
    cached = new KindeBilling(components.convexKindeBilling, {
      KINDE_ISSUER_URL: process.env.KINDE_ISSUER_URL!,
    });
  }
  return cached;
}

// `webhookHandler` is a built httpAction; `_handler` is its underlying
// (ctx, request) => Response function. We delegate to `_handler` directly rather
// than invoking the action object, which would log a "don't call directly"
// warning on every request.
type RawHttpHandler = (
  ctx: GenericActionCtx<GenericDataModel>,
  request: Request,
) => Promise<Response>;

const http = httpRouter();

http.route({
  path: "/webhooks/kinde/billing",
  method: "POST",
  // Delegate to the cached client's handler. getKindeBilling() constructs on the
  // first request only, so the JWKS client is still created exactly once.
  handler: httpActionGeneric((ctx, request) =>
    (
      getKindeBilling().webhookHandler as unknown as {
        _handler: RawHttpHandler;
      }
    )._handler(ctx, request),
  ),
});

export default http;