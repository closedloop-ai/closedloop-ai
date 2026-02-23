"use client";

import { useEffect } from "react";
import { onMcpAuthorization } from "use-mcp";

export default function OAuthCallback() {
  useEffect(() => {
    onMcpAuthorization();
  }, []);

  return <p>Authenticating... this window should close automatically.</p>;
}
