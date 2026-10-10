// SAML 2.0 service-provider settings checks.
//
// Scope note: this is the *settings* surface the profile page drives — validate
// the IdP entry point / SP entity id / IdP certificate, and publish the SP
// metadata an IdP administrator imports. The ACS endpoint that would consume a
// signed assertion is a separate, larger piece of work and is deliberately not
// pretended here.
//
// No XML/crypto dependency: node:crypto's X509Certificate parses the IdP cert
// and the metadata document is a fixed template.

import { X509Certificate } from "node:crypto";

export const DEFAULT_SAML_ISSUER = "urn:vansrouter:sp";
export const SAML_ACS_PATH = "/api/auth/saml/acs";
export const SAML_METADATA_PATH = "/api/auth/saml/metadata";

export function normalizeSamlCert(cert) {
  return String(cert || "")
    .replace(/-----BEGIN CERTIFICATE-----/g, "")
    .replace(/-----END CERTIFICATE-----/g, "")
    .replace(/\s+/g, "");
}

// A usable IdP certificate is one X509Certificate can actually parse — a
// base64 blob that merely looks right would fail at first login, which is
// exactly the failure this check exists to prevent.
export function isValidSamlCert(cert) {
  const body = normalizeSamlCert(cert);
  if (!body) return false;
  try {
    const parsed = new X509Certificate(Buffer.from(body, "base64"));
    return Boolean(parsed.subject);
  } catch {
    return false;
  }
}

export function isValidEntryPoint(entryPoint) {
  try {
    const url = new URL(String(entryPoint));
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export function xmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function spMetadataXml(issuer, acsUrl) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${xmlEscape(issuer)}">
  <md:SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="false" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>
    <md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${xmlEscape(acsUrl)}" index="0"/>
  </md:SPSSODescriptor>
</md:EntityDescriptor>
`;
}

// The origin the browser is actually on — behind a tunnel this is the only
// correct answer for the ACS/metadata URLs handed to an IdP.
export function publicOrigin(request) {
  const envOrigin = process.env.PUBLIC_ORIGIN || process.env.APP_ORIGIN;
  if (envOrigin) return String(envOrigin).replace(/\/+$/, "");
  const url = new URL(request.url);
  const forwardedHost = request.headers.get("x-forwarded-host");
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const host = forwardedHost || request.headers.get("host") || url.host;
  const proto = forwardedProto || url.protocol.replace(":", "");
  return `${proto}://${host}`;
}
