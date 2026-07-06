import { NextResponse } from "next/server";
import { proxy as dashboardProxy } from "./dashboardGuard";

const isDev = process.env.NODE_ENV === "development";
const backendBase = process.env.NINEROUTER_BACKEND_URL || "http://localhost:20128";

export default async function proxy(request) {
  const { pathname, search } = request.nextUrl;

  // In development, proxy API calls to the Go backend so the dashboard
  // exercises the ported server instead of the legacy src/app/api handlers.
  // In production, Caddy performs this routing, so the proxy is a no-op.
  if (isDev && (
      pathname.startsWith("/api/") || pathname === "/api" ||
      pathname.startsWith("/v1/") || pathname === "/v1" ||
      pathname === "/models" || pathname === "/health" || pathname === "/version")) {
    return NextResponse.rewrite(new URL(`${pathname}${search}`, backendBase));
  }

  return dashboardProxy(request);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico).*)"],
};
