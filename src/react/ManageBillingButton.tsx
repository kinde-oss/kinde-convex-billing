import { useAction } from "convex/react";
import { useState } from "react";
import type { FunctionReference } from "convex/server";

// A reference to a Convex **action** you expose in your own app (see the example
// `getPortalUrl` in the README). The button calls it with `useAction`; the
// action calls Kinde's Account API server-side using the user's access token.
// The arg shape mirrors the client's `getPortalUrl(userAccessToken, { returnUrl,
// subNav })` so the button, action, and client method all agree on one signature.
type GetPortalUrlFn = FunctionReference<
  "action",
  "public",
  { userAccessToken: string; returnUrl?: string; subNav?: string },
  { url: string }
>;

type ManageBillingButtonProps = {
  getPortalUrl: GetPortalUrlFn;
  userAccessToken: string;
  returnUrl?: string;
  subNav?: string;
  children?: React.ReactNode;
  className?: string;
};

export function ManageBillingButton({
  getPortalUrl,
  userAccessToken,
  returnUrl,
  subNav,
  children = "Manage Billing",
  className,
}: ManageBillingButtonProps) {
  const generatePortalUrl = useAction(getPortalUrl);
  const [loading, setLoading] = useState(false);

  const handleClick = async () => {
    setLoading(true);
    try {
      const { url } = await generatePortalUrl({
        userAccessToken,
        returnUrl,
        subNav,
      });
      window.location.href = url;
    } finally {
      setLoading(false);
    }
  };

  return (
    <button onClick={handleClick} disabled={loading} className={className}>
      {loading ? "Loading..." : children}
    </button>
  );
}
