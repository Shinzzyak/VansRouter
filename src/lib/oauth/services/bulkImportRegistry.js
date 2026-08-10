import {
  applyBulkImportProxyMode,
  resolveBulkImportProxy,
} from "./bulkImportProxyResolver.js";
import { getSettings } from "@/lib/db/repos/settingsRepo";

/**
 * Registry of bulk-import providers. Each spec is a lazy adapter over a
 * provider-specific KiroBulkImportManager subclass. Managers are heavy
 * (Playwright) so getManager + parseAccounts resolve via dynamic import()
 * to keep cold start cheap for unrelated routes.
 *
 * Shape:
 * - getManager(): Promise<Manager>                 — singleton factory
 * - parseAccounts(accounts): Promise<{parsed,invalidLines}> | null
 *                                                   — null for 5sim flows
 * - normalizeStartArgs(body, resolvedProxy): args  — maps request body to startJob args
 * - applyProxyMode: boolean                        — codebuddy-cn post-processes proxy
 * - staleOnLatest404: boolean                      — wire-format compatibility for /latest 404
 * - label / errorLabel: string                      — human-readable names + 404 messages
 */
export const BULK_IMPORT_PROVIDERS = Object.freeze({
  kiro: {
    label: "Kiro",
    errorLabel: "Bulk import job",
    staleOnLatest404: true,
    parseAccounts: (accounts) =>
      import("./kiroBulkImportManager.js").then((m) => m.parseKiroBulkAccounts(accounts)),
    getManager: () =>
      import("./kiroBulkImportManager.js").then((m) => m.getKiroBulkImportManager()),
    normalizeStartArgs: (body, resolvedProxy) => ({
      accounts: body?.accounts ?? [],
      concurrency: body?.concurrency,
      engine: body?.engine,
      headless: body?.headless,
      proxyUrl: resolvedProxy.proxyUrl,
      proxyUrls: resolvedProxy.proxyUrls,
      proxyMode: resolvedProxy.proxyMode,
      proxyPoolId: resolvedProxy.proxyPoolId,
      proxySource: resolvedProxy.proxySource,
      randomizeProxySession: body?.randomizeProxySession,
    }),
  },
  "grok-cli": {
    label: "Grok CLI",
    errorLabel: "Grok CLI register job",
    staleOnLatest404: true,
    // registerCount mode skips client account parse; token paste uses parseAccounts.
    parseAccounts: (accounts) =>
      import("./grokBulkImportManager.js").then((m) => m.parseGrokBulkAccounts(accounts)),
    getManager: () =>
      import("./grokBulkImportManager.js").then((m) => m.getGrokBulkImportManager()),
    normalizeStartArgs: (body, resolvedProxy) => ({
      accounts: body?.accounts ?? [],
      concurrency: body?.concurrency,
      engine: body?.engine,
      headless: body?.headless,
      proxyUrl: resolvedProxy.proxyUrl,
      proxyUrls: resolvedProxy.proxyUrls,
      proxyMode: resolvedProxy.proxyMode,
      proxyPoolId: resolvedProxy.proxyPoolId,
      proxySource: resolvedProxy.proxySource,
      randomizeProxySession: body?.randomizeProxySession,
      registerCount: body?.registerCount,
      mailProvider: body?.mailProvider,
      mailApi: body?.mailApi,
      mailDomains: body?.mailDomains,
      mailApiKey: body?.mailApiKey,
      mailAuthMode: body?.mailAuthMode,
      enableNsfw: body?.enableNsfw,
      yydsApiKey: body?.yydsApiKey,
      yydsJwt: body?.yydsJwt,
    }),
  },
  qoder: {
    label: "Qoder",
    errorLabel: "Bulk import job",
    staleOnLatest404: true,
    parseAccounts: (accounts) =>
      import("./qoderBulkImportManager.js").then((m) => m.parseQoderBulkAccounts(accounts)),
    getManager: () =>
      import("./qoderBulkImportManager.js").then((m) => m.getQoderBulkImportManager()),
    normalizeStartArgs: (body, resolvedProxy) => ({
      accounts: body?.accounts ?? [],
      concurrency: body?.concurrency,
      engine: body?.engine,
      headless: body?.headless,
      proxyUrl: resolvedProxy.proxyUrl,
      proxyUrls: resolvedProxy.proxyUrls,
      proxyMode: resolvedProxy.proxyMode,
      proxyPoolId: resolvedProxy.proxyPoolId,
      proxySource: resolvedProxy.proxySource,
      randomizeProxySession: body?.randomizeProxySession,
    }),
  },
  "tokenharbor-signup": {
    label: "Token Harbor Signup",
    errorLabel: "Token Harbor signup job",
    staleOnLatest404: true,
    parseAccounts: (accounts) => Promise.resolve(accounts || []),
    getManager: () =>
      import("./tokenHarborSignupManager.js").then((m) => m.getTokenHarborSignupManager()),
    normalizeStartArgs: (body, resolvedProxy) => ({
      accounts: [],
      concurrency: body?.concurrency,
      engine: body?.engine,
      headless: body?.headless,
      proxyUrl: resolvedProxy.proxyUrl || body?.proxyUrl,
      registerCount: body?.registerCount,
      yydsApiKey: body?.yydsApiKey,
      yydsDomain: body?.yydsDomain,
      seedInvite: body?.seedInvite,
    }),
  },
  "qoder-signup": {
    label: "Qoder Signup",
    errorLabel: "Qoder signup job",
    staleOnLatest404: true,
    parseAccounts: (accounts) => Promise.resolve(accounts || []),
    getManager: () =>
      import("./qoderBulkSignupManager.js").then((m) => m.getQoderBulkSignupManager()),
    normalizeStartArgs: (body, resolvedProxy) => ({
      accounts: [],
      concurrency: body?.concurrency,
      engine: body?.engine,
      headless: body?.headless,
      proxyUrl: resolvedProxy.proxyUrl || body?.proxyUrl,
      registerCount: body?.registerCount,
      yydsApiKey: body?.yydsApiKey,
      yydsDomain: body?.yydsDomain,
    }),
  },
  "baseten-signup": {
    label: "Baseten Signup",
    errorLabel: "Baseten signup job",
    staleOnLatest404: true,
    parseAccounts: (accounts) => Promise.resolve(accounts || []),
    getManager: () =>
      import("./basetenSignupManager.js").then((m) => m.getBasetenSignupManager()),
    normalizeStartArgs: (body, resolvedProxy) => ({
      accounts: [],
      concurrency: body?.concurrency,
      engine: body?.engine,
      headless: body?.headless,
      proxyUrl: resolvedProxy.proxyUrl || body?.proxyUrl,
      registerCount: body?.registerCount,
      yydsApiKey: body?.yydsApiKey,
      yydsDomain: body?.yydsDomain,
    }),
  },
  "codebuddy-intl": {
    label: "CodeBuddy",
    errorLabel: "Bulk import job",
    staleOnLatest404: true,
    parseAccounts: (accounts) =>
      import("./codebuddyBulkImportManager.js").then((m) => m.parseCodeBuddyBulkAccounts(accounts)),
    getManager: () =>
      import("./codebuddyBulkImportManager.js").then((m) => m.getCodeBuddyBulkImportManager()),
    normalizeStartArgs: (body, resolvedProxy) => ({
      accounts: body?.accounts ?? [],
      concurrency: body?.concurrency,
      engine: body?.engine,
      headless: body?.headless,
      proxyUrl: resolvedProxy.proxyUrl,
      proxyUrls: resolvedProxy.proxyUrls,
      proxyMode: resolvedProxy.proxyMode,
      proxyPoolId: resolvedProxy.proxyPoolId,
      proxySource: resolvedProxy.proxySource,
      randomizeProxySession: body?.randomizeProxySession,
    }),
  },
  "codebuddy-cn": {
    label: "CodeBuddy CN",
    errorLabel: "CodeBuddy CN phone import job",
    staleOnLatest404: false,
    applyProxyMode: true,
    // 5sim flow: no client-side account parsing; manager handles phone OTP.
    parseAccounts: null,
    getManager: () =>
      import("./codebuddyCnPhoneImportManager.js").then((m) => m.getCodeBuddyCnPhoneImportManager()),
    normalizeStartArgs: (body, resolvedProxy) => ({
      fiveSimToken: body?.fiveSimToken,
      count: body?.count,
      concurrency: body?.concurrency,
      engine: body?.engine,
      country: body?.country,
      operator: body?.operator,
      product: body?.product,
      proxyUrl: resolvedProxy.proxyUrl,
      proxyUrls: resolvedProxy.proxyUrls,
      proxyMode: resolvedProxy.proxyMode,
      proxyPoolId: resolvedProxy.proxyPoolId,
      proxySource: resolvedProxy.proxySource,
      randomizeProxySession: body?.randomizeProxySession,
    }),
  },
  autoclaw: {
    label: "AutoClaw",
    errorLabel: "AutoClaw import job",
    staleOnLatest404: true,
    parseAccounts: (accounts) =>
      import("./kiroBulkImportManager.js").then((m) => m.parseKiroBulkAccounts(accounts)),
    getManager: () =>
      import("./autoclawBulkImportManager.js").then((m) => m.getAutoclawBulkImportManager()),
    normalizeStartArgs: (body, resolvedProxy) => ({
      accounts: body?.accounts ?? [],
      concurrency: body?.concurrency,
      engine: body?.engine,
      headless: body?.headless,
      proxyUrl: resolvedProxy.proxyUrl,
      proxyUrls: resolvedProxy.proxyUrls,
      proxyMode: resolvedProxy.proxyMode,
      proxyPoolId: resolvedProxy.proxyPoolId,
      proxySource: resolvedProxy.proxySource,
      randomizeProxySession: body?.randomizeProxySession,
    }),
  },
  "autoclaw-signup": {
    label: "AutoClaw Signup",
    errorLabel: "AutoClaw signup job",
    staleOnLatest404: true,
    parseAccounts: (accounts) => Promise.resolve(accounts || []),
    getManager: () =>
      import("./autoclawBulkSignupManager.js").then((m) => m.getAutoclawBulkSignupManager()),
    normalizeStartArgs: (body, resolvedProxy) => ({
      accounts: [],
      concurrency: body?.concurrency,
      engine: body?.engine,
      headless: body?.headless,
      proxyUrl: resolvedProxy.proxyUrl || body?.proxyUrl,
      registerCount: body?.registerCount,
      yydsApiKey: body?.yydsApiKey,
      yydsDomain: body?.yydsDomain,
    }),
  },
  "outlook-signup": {
    label: "Outlook Signup",
    errorLabel: "Outlook signup job",
    staleOnLatest404: true,
    parseAccounts: (accounts) => Promise.resolve(accounts || []),
    getManager: () =>
      import("./outlookBulkSignupManager.js").then((m) => m.getOutlookBulkSignupManager()),
    normalizeStartArgs: async (body, resolvedProxy) => {
      // YYDS_API_KEY untuk recovery mailbox (graph token flow). Fallback settings DB.
      const settings = await getSettings().catch(() => ({}));
      return {
        accounts: [],
        concurrency: body?.concurrency,
        proxyUrl: resolvedProxy.proxyUrl || body?.proxyUrl,
        registerCount: body?.registerCount,
        mode: body?.outlookMode || body?.mode || "auto",
        yydsApiKey: body?.yydsApiKey || settings.yydsApiKey || "",
      };
    },
  },
  "chatgpt-signup": {
    label: "ChatGPT Signup",
    errorLabel: "ChatGPT signup job",
    staleOnLatest404: true,
    parseAccounts: (accounts) => Promise.resolve(accounts || []),
    getManager: () =>
      import("./chatgptBulkSignupManager.js").then((m) => m.getChatGptBulkSignupManager()),
    normalizeStartArgs: async (body, resolvedProxy) => {
      // Modal kirim tempMailToken:"" — fallback settings yydsApiKey (YYDS Bearer).
      const settings = await getSettings().catch(() => ({}));
      return {
        accounts: [],
        concurrency: body?.concurrency,
        proxyUrl: resolvedProxy.proxyUrl || body?.proxyUrl,
        registerCount: body?.registerCount,
        tempMailApi: body?.tempMailApi,
        tempMailToken: body?.tempMailToken || settings.yydsApiKey || "",
      };
    },
  },
});

export function isValidBulkImportProvider(providerId) {
  return Object.prototype.hasOwnProperty.call(BULK_IMPORT_PROVIDERS, providerId);
}

export function getBulkImportProviderSpec(providerId) {
  if (!isValidBulkImportProvider(providerId)) {
    const valid = Object.keys(BULK_IMPORT_PROVIDERS).join(", ");
    const error = new Error(`Unknown bulk import provider: ${providerId}. Valid: ${valid}`);
    error.statusCode = 400;
    throw error;
  }
  return BULK_IMPORT_PROVIDERS[providerId];
}

/**
 * Resolve proxy for a bulk import job. account-bearing providers use
 * resolveBulkImportProxy directly; codebuddy-cn additionally applies
 * applyBulkImportProxyMode to honor the client's proxyMode preference.
 */
export async function resolveProxyForProvider(spec, body) {
  const resolved = await resolveBulkImportProxy({
    proxyPoolId: body?.proxyPoolId,
    proxyUrl: body?.proxyUrl,
  });
  if (spec.applyProxyMode) {
    return applyBulkImportProxyMode(resolved, body?.proxyMode);
  }
  return resolved;
}

export { applyBulkImportProxyMode, resolveBulkImportProxy };
