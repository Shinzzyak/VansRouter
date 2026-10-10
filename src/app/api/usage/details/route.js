import { NextResponse } from "next/server";
import { getRequestDetails } from "@/lib/usageDb";

// Port-compat alias for the Go router's GET /api/usage/details, which returns
// { details, pagination: { totalItems } }. Reuses the same query surface as
// /api/usage/request-details; only the response envelope differs.
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);

    const pageRaw = parseInt(searchParams.get("page"), 10);
    const page = Number.isNaN(pageRaw) ? 1 : pageRaw;
    const pageSizeRaw = parseInt(searchParams.get("pageSize"), 10);
    const pageSize = Number.isNaN(pageSizeRaw) ? 20 : pageSizeRaw;

    if (page < 1) return NextResponse.json({ error: "Page must be >= 1" }, { status: 400 });
    if (pageSize < 1 || pageSize > 100) {
      return NextResponse.json({ error: "PageSize must be between 1 and 100" }, { status: 400 });
    }

    const filter = { page, pageSize };
    for (const key of ["provider", "model", "connectionId", "status", "startDate", "endDate"]) {
      const value = searchParams.get(key);
      if (value) filter[key] = value;
    }

    const result = await getRequestDetails(filter);

    const details = (result.details || []).map((detail) => {
      const redacted = { ...detail };
      for (const key of ["request", "providerRequest", "providerResponse", "response"]) {
        if (redacted[key] !== undefined) redacted[key] = { redacted: true };
      }
      return redacted;
    });

    const totalItems =
      result.pagination?.totalItems ?? result.total ?? result.totalItems ?? details.length;

    return NextResponse.json({ details, pagination: { totalItems } });
  } catch (error) {
    console.error("[API] Failed to get request details:", error);
    return NextResponse.json({ error: "Failed to fetch request details" }, { status: 500 });
  }
}
