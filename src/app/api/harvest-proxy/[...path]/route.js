import { NextResponse } from "next/server";
import { requireDashboardAuth } from "@/lib/auth/routeAuth.js";

export const dynamic = "force-dynamic";

const HARVEST_BASE = "http://127.0.0.1:3088/api";

async function proxyRequest(request, path) {
  const segments = path.map(decodeURIComponent);
  const url = `${HARVEST_BASE}/${segments.map(encodeURIComponent).join("/")}`;

  const headers = {
    accept: "application/json",
  };
  if (request.headers.get("content-type")) {
    headers["content-type"] = request.headers.get("content-type");
  }

  const init = { method: request.method, headers, cache: "no-store" };
  if (request.method !== "GET" && request.method !== "HEAD") {
    const body = await request.text();
    if (body) init.body = body;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const upstream = await fetch(url, { ...init, signal: controller.signal });
    const text = await upstream.text();
    const contentType = upstream.headers.get("content-type") || "";
    return new NextResponse(text, {
      status: upstream.status,
      headers: {
        "content-type": contentType || "application/json",
      },
    });
  } catch (e) {
    const aborted = e.name === "AbortError";
    return NextResponse.json(
      { error: aborted ? "harvest console timeout" : `harvest console error: ${e.message}` },
      { status: aborted ? 504 : 502 }
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function GET(request, { params }) {
  if (!await requireDashboardAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { path } = await params;
  return proxyRequest(request, path || []);
}

export async function POST(request, { params }) {
  if (!await requireDashboardAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { path } = await params;
  return proxyRequest(request, path || []);
}

export async function PUT(request, { params }) {
  if (!await requireDashboardAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { path } = await params;
  return proxyRequest(request, path || []);
}

export async function DELETE(request, { params }) {
  if (!await requireDashboardAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { path } = await params;
  return proxyRequest(request, path || []);
}
