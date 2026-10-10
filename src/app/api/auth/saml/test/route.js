import { NextResponse } from "next/server";
import { requireDashboardAuth } from "@/lib/auth/routeAuth.js";
import { getSettings } from "@/lib/localDb";
import {
  DEFAULT_SAML_ISSUER,
  SAML_ACS_PATH,
  SAML_METADATA_PATH,
  isValidEntryPoint,
  isValidSamlCert,
  publicOrigin,
} from "@/lib/auth/saml.js";

export const dynamic = "force-dynamic";

// POST /api/auth/saml/test — validate the SSO settings before they are saved.
// Body fields override what is already stored, so the profile page can test an
// edit that has not been persisted yet.
export async function POST(request) {
  if (!(await requireDashboardAuth(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json().catch(() => ({}));
    const settings = await getSettings();

    const pick = (field) =>
      Object.prototype.hasOwnProperty.call(body, field) ? body[field] : settings[field];

    const entryPoint = String(pick("samlEntryPoint") || "").trim();
    const issuer = String(pick("samlIssuer") || "").trim() || DEFAULT_SAML_ISSUER;
    const cert = String(pick("samlCert") || "").trim();

    if (!entryPoint) {
      return NextResponse.json({ error: "Single Sign-On Service URL (samlEntryPoint) is required" }, { status: 400 });
    }
    if (!isValidEntryPoint(entryPoint)) {
      return NextResponse.json({ error: "Single Sign-On Service URL must be a valid http(s) URL" }, { status: 400 });
    }
    if (!cert) {
      return NextResponse.json({ error: "IdP X.509 Certificate (samlCert) is required" }, { status: 400 });
    }
    if (!isValidSamlCert(cert)) {
      return NextResponse.json({ error: "Invalid IdP X.509 Certificate format" }, { status: 400 });
    }

    const origin = publicOrigin(request);
    return NextResponse.json({
      ok: true,
      samlEntryPoint: entryPoint,
      samlIssuer: issuer,
      certValid: true,
      acsUrl: origin + SAML_ACS_PATH,
      metadataUrl: origin + SAML_METADATA_PATH,
      message: "SAML 2.0 configuration verified successfully.",
    });
  } catch (error) {
    console.error("POST /api/auth/saml/test failed:", error);
    return NextResponse.json({ error: "SAML configuration check failed" }, { status: 500 });
  }
}
