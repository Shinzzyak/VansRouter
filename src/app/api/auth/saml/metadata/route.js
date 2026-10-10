import { getSettings } from "@/lib/localDb";
import {
  DEFAULT_SAML_ISSUER,
  SAML_ACS_PATH,
  publicOrigin,
  spMetadataXml,
} from "@/lib/auth/saml.js";

export const dynamic = "force-dynamic";

// GET /api/auth/saml/metadata — the SP metadata document an IdP admin imports.
// Unauthenticated on purpose: it contains no secrets and the IdP fetches it.
export async function GET(request) {
  try {
    const settings = await getSettings();
    const issuer = String(settings.samlIssuer || "").trim() || DEFAULT_SAML_ISSUER;
    const acsUrl = publicOrigin(request) + SAML_ACS_PATH;

    return new Response(spMetadataXml(issuer, acsUrl), {
      status: 200,
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
        "Cache-Control": "no-cache",
      },
    });
  } catch (error) {
    console.error("GET /api/auth/saml/metadata failed:", error);
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?>\n<error>Failed to build SAML metadata</error>\n`,
      { status: 500, headers: { "Content-Type": "application/xml; charset=utf-8" } }
    );
  }
}
