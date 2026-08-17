"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Button,
  BulkAccountAutomationModal,
  Card,
  CardSkeleton,
  CloudflareTokenImportModal,
  CodeBuddyCnPhoneAutomationModal,
  KiroOAuthWrapper,
  Modal,
  OAuthModal,
  AutoclawAutomationModal,
  GrokRegisterModal,
  GrokSsoImportModal,
  QoderSignupModal,
  AutoclawSignupModal,
  OutlookSignupModal,
  ChatGptSignupModal,
  TokenHarborSignupModal,
  BasetenSignupModal,
} from "@/shared/components";
import ProviderIcon from "@/shared/components/ProviderIcon";
import { FREE_PROVIDERS } from "@/shared/constants/providers";

function getConnectionLabel(count) {
  return `${count} connection${count === 1 ? "" : "s"}`;
}

// ── Automation History — hasil semua automation (signup/bulk-import) ──────
const STATUS_BADGE = {
  success: "bg-green-500/10 text-green-600 dark:text-green-400",
  completed: "bg-green-500/10 text-green-600 dark:text-green-400",
  failed: "bg-red-500/10 text-red-600 dark:text-red-400",
  cancelled: "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400",
  running: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  queued: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  needs_verify: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  needs_manual: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
};

function AutomationHistoryPanel() {
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/automation-history?limit=20", { cache: "no-store" });
      const data = await res.json();
      if (data.success) setJobs(data.jobs || []);
      else setError(data.error || "Failed to load history");
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  const fmtTime = (iso) => {
    if (!iso) return "—";
    const d = new Date(iso);
    return d.toLocaleString("id-ID", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  };

  return (
    <Card className="mt-4">
      <div className="flex items-center justify-between px-4 pt-4">
        <h3 className="text-sm font-semibold">Hasil Automation</h3>
        <button
          type="button"
          onClick={load}
          className="rounded-md border border-border px-2 py-1 text-[11px] text-text-muted hover:bg-white/5"
        >
          ↻ Refresh
        </button>
      </div>
      <div className="p-4">
        {loading ? (
          <p className="text-xs text-text-muted">Loading…</p>
        ) : error ? (
          <p className="text-xs text-red-500">{error}</p>
        ) : jobs.length === 0 ? (
          <p className="text-xs text-text-muted">Belum ada job automation.</p>
        ) : (
          <div className="space-y-2">
            {jobs.map((j) => (
              <div
                key={j.jobId}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border bg-background px-3 py-2 text-xs"
              >
                <span className="font-medium">{j.provider}</span>
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                    STATUS_BADGE[j.status] || "bg-white/5 text-text-muted"
                  }`}
                >
                  {j.status}
                </span>
                <span className="text-text-muted">{fmtTime(j.createdAt)}</span>
                <span className="text-text-muted">
                  {j.total} akun ·{" "}
                  {Object.entries(j.counts)
                    .map(([k, v]) => `${k}:${v}`)
                    .join(" · ")}
                </span>
                {j.error && <span className="text-red-500">⚠ {j.error}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

function KiroAutomationPanel({ providerInfo, onRefresh }) {
  const [isOpen, setIsOpen] = useState(false);
  const [isBulkOpen, setIsBulkOpen] = useState(false);
  const [bulkJob, setBulkJob] = useState(null);
  const [initialFlow, setInitialFlow] = useState(null);
  const openFlow = (flow) => {
    setInitialFlow({ ...flow, key: Date.now() });
    setIsOpen(true);
  };

  const options = [
    {
      id: "bulk-account",
      title: "Auto Login Bulk",
      icon: "group_add",
      description: "Run bulk gmail|password automation with worker progress and manual assist.",
      action: () => {
        console.log("[Kiro Automation] Opening BulkAccountAutomationModal");
        setIsBulkOpen(true);
      },
    },
    {
      id: "bulk-token",
      title: "Bulk Token",
      icon: "playlist_add",
      description: "Import many Kiro refresh tokens, one token per line.",
      action: () => openFlow({ method: "import", importMode: "bulk-token" }),
    },
    {
      id: "single-token",
      title: "Single Token",
      icon: "vpn_key",
      description: "Auto-detect or paste one Kiro refresh token.",
      action: () => openFlow({ method: "import", importMode: "single-token" }),
    },
    {
      id: "builder-id",
      title: "AWS Builder ID",
      icon: "shield",
      description: "Open the standard AWS Builder ID device login.",
      action: () => openFlow({ method: "builder-id" }),
    },
    {
      id: "idc",
      title: "AWS IDC",
      icon: "business",
      description: "Enter an IAM Identity Center start URL and region.",
      action: () => openFlow({ method: "idc" }),
    },
    {
      id: "google",
      title: "Google Login",
      icon: "account_circle",
      description: "Open Kiro social Google login with callback capture.",
      action: () => openFlow({ method: "social", provider: "google" }),
    },
  ];

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={option.action}
            className="block min-w-0"
          >
            <Card
              hover
              padding="sm"
              className="flex min-h-[112px] flex-col gap-2 cursor-pointer h-full hover:border-brand-500/30 transition-colors"
            >
              <span className="flex items-center gap-2 text-sm font-semibold text-text-main">
                <span className="material-symbols-outlined text-[20px] text-brand-500">{option.icon}</span>
                {option.title}
              </span>
              <span className="text-xs leading-relaxed text-text-muted">{option.description}</span>
            </Card>
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {bulkJob?.jobId && (
          <Badge variant="default">
            Bulk job: {bulkJob.status}
          </Badge>
        )}
        {bulkJob?.jobId && (
          <Button
            size="sm"
            variant="secondary"
            icon="monitoring"
            onClick={() => openFlow({ method: "import", importMode: "bulk-account" })}
          >
            Resume Bulk Progress
          </Button>
        )}
      </div>
      <KiroOAuthWrapper
        isOpen={isOpen}
        providerInfo={providerInfo}
        onSuccess={onRefresh}
        onRefresh={onRefresh}
        initialBulkJobId={bulkJob?.jobId || null}
        initialFlow={initialFlow}
        onBulkJobChange={setBulkJob}
        onClose={() => setIsOpen(false)}
      />
      <BulkAccountAutomationModal
        isOpen={isBulkOpen}
        provider="kiro"
        title="Kiro Bulk GSuite Auto Login"
        serviceName="Kiro"
        onSuccess={onRefresh}
        onClose={() => setIsBulkOpen(false)}
      />
    </>
  );
}

function CodeBuddyBulkTokenModal({ isOpen, onClose, onSuccess }) {
  const [tokens, setTokens] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  const handleImport = async () => {
    if (!tokens.trim()) return;
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch("/api/oauth/codebuddy/bulk-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tokens }),
      });
      const data = await res.json();
      setResult(data);
      if (data.success) onSuccess?.();
    } catch (error) {
      setResult({ error: error.message });
    } finally {
      setLoading(false);
    }
  };

  // Build detailed success message with format breakdown
  let successMsg = null;
  if (result?.success) {
    const parts = [`Imported ${result.imported}/${result.total} tokens.`];
    if (result.failed) parts.push(`${result.failed} failed.`);

    // Show format breakdown if available
    if (result.formatCounts) {
      const { "access-only": ao, "with-refresh": wr, "with-api-key": wa } = result.formatCounts;
      const breakdown = [];
      if (wa) breakdown.push(`${wa} with API key`);
      if (wr) breakdown.push(`${wr} with refresh token`);
      if (ao) breakdown.push(`${ao} access-only`);
      if (breakdown.length) parts.push(`(${breakdown.join(", ")})`);
    }

    successMsg = parts.join(" ");
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="CodeBuddy OAuth Token Import" size="lg">
      <div className="flex flex-col gap-4">
        <p className="text-xs text-text-muted">Paste CodeBuddy OAuth tokens, one per line. Supports three formats:</p>
        <div className="flex flex-col gap-2 rounded-[10px] bg-background/50 p-3 text-xs text-text-muted">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[18px] text-brand-500 leading-none">check_circle</span>
            <span className="flex items-center gap-1.5"><code className="text-[10px] bg-border/50 px-1.5 py-0.5 rounded leading-none">accessToken</code><span>— access token only (24h expiry)</span></span>
          </div>
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[18px] text-brand-500 leading-none">check_circle</span>
            <span className="flex items-center gap-1.5"><code className="text-[10px] bg-border/50 px-1.5 py-0.5 rounded leading-none">accessToken:refreshToken</code><span>— enables auto-refresh</span></span>
          </div>
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[18px] text-brand-500 leading-none">check_circle</span>
            <span className="flex items-center gap-1.5"><code className="text-[10px] bg-border/50 px-1.5 py-0.5 rounded leading-none">accessToken:refreshToken:apiKey</code><span>— 365-day access</span></span>
          </div>
        </div>
        <textarea
          className="w-full rounded-[10px] border border-border bg-background p-3 font-mono text-xs text-text-main placeholder:text-text-muted focus:border-brand-500/40 focus:ring-2 focus:ring-brand-500/30 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
          rows={8}
          placeholder={
            "eyJhbGciOiJSUzI1NiIs...\n" +
            "eyJhbGciOiJSUzI1NiIs...:eyJhbGciOiJSUzI1NiIs...\n" +
            "eyJhbGciOiJSUzI1NiIs...:eyJhbGciOiJSUzI1NiIs...:ak_abc123..."
          }
          value={tokens}
          onChange={(e) => setTokens(e.target.value)}
          disabled={loading}
        />
        {result && (
          <div className={`rounded-[10px] p-3 text-xs ${result.success ? "bg-green-500/10 text-green-600 dark:text-green-400" : "bg-red-500/10 text-red-600 dark:text-red-400"}`}>
            {successMsg || result.error || "Import failed"}
          </div>
        )}
        <div className="flex gap-2 pt-2">
          <Button variant="outline" onClick={onClose} fullWidth disabled={loading}>
            Close
          </Button>
          <Button
            variant="primary"
            onClick={handleImport}
            disabled={loading || !tokens.trim()}
            loading={loading}
            fullWidth
          >
            Import Tokens
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function CodeBuddyAutomationPanel({ providerInfo, onRefresh }) {
  const [isOpen, setIsOpen] = useState(false);
  const [isBulkOpen, setIsBulkOpen] = useState(false);
  const [isBulkTokenOpen, setIsBulkTokenOpen] = useState(false);

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <button type="button" onClick={() => setIsBulkOpen(true)} className="text-left">
          <Card
            hover
            padding="md"
            icon="group_add"
            title="Auto Login + Generate Key"
            subtitle="Run bulk GSuite gmail|password login, create a CodeBuddy Access Key, and save it for model calls."
          />
        </button>
        <button type="button" onClick={() => setIsBulkTokenOpen(true)} className="text-left">
          <Card
            hover
            padding="md"
            icon="playlist_add"
            title="OAuth Token Import"
            subtitle="Paste OAuth tokens with optional refresh tokens and API keys for extended access."
          />
        </button>
        <button type="button" onClick={() => setIsOpen(true)} className="text-left">
          <Card
            hover
            padding="md"
            icon="login"
            title="Device OAuth Login"
            subtitle="Open CodeBuddy browser login and poll until the OAuth token is saved."
          />
        </button>
      </div>
      <CodeBuddyBulkTokenModal
        isOpen={isBulkTokenOpen}
        onClose={() => setIsBulkTokenOpen(false)}
        onSuccess={onRefresh}
      />
      <BulkAccountAutomationModal
        isOpen={isBulkOpen}
        provider="codebuddy-intl"
        title="CodeBuddy Bulk GSuite Login + Access Key"
        serviceName="CodeBuddy"
        onSuccess={onRefresh}
        onClose={() => setIsBulkOpen(false)}
      />
      <OAuthModal
        isOpen={isOpen}
        provider="codebuddy-intl"
        providerInfo={providerInfo}
        onSuccess={() => {
          onRefresh?.();
          setIsOpen(false);
        }}
        onClose={() => setIsOpen(false)}
      />
    </>
  );
}

function CodeBuddyCnAutomationPanel({ onRefresh }) {
  const [isPhoneOpen, setIsPhoneOpen] = useState(false);

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <button type="button" onClick={() => setIsPhoneOpen(true)} className="text-left">
          <Card
            hover
            padding="md"
            icon="phone_iphone"
            title="Phone OTP + Generate Key"
            subtitle="Buy 5sim SMS OTP, login to CodeBuddy CN, generate an API key from the authenticated browser session, and save it."
          />
        </button>
      </div>
      <CodeBuddyCnPhoneAutomationModal
        isOpen={isPhoneOpen}
        onSuccess={onRefresh}
        onClose={() => setIsPhoneOpen(false)}
      />
    </>
  );
}

function QoderAutomationPanel({ providerInfo, onRefresh }) {
  const [isBulkOpen, setIsBulkOpen] = useState(false);
  const [isOAuthOpen, setIsOAuthOpen] = useState(false);
  const [isSignupOpen, setIsSignupOpen] = useState(false);

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <button type="button" onClick={() => setIsBulkOpen(true)} className="text-left">
          <Card
            hover
            padding="md"
            icon="group_add"
            title="Auto Login Bulk"
            subtitle="Run bulk gmail:password or gmail|password automation via Google SSO with Qoder device flow."
          />
        </button>
        <button type="button" onClick={() => setIsSignupOpen(true)} className="text-left">
          <Card
            hover
            padding="md"
            icon="person_add"
            title="Signup Bulk (YYDS temp mail)"
            subtitle="Register new Qoder accounts with fresh YYDS inboxes: signup form → Aliyun slider → OTP → device authorize."
          />
        </button>
        <button type="button" onClick={() => setIsOAuthOpen(true)} className="text-left">
          <Card
            hover
            padding="md"
            icon="login"
            title="Device OAuth Login"
            subtitle="Open Qoder device login in browser and poll until the token is saved."
          />
        </button>
      </div>
      <BulkAccountAutomationModal
        isOpen={isBulkOpen}
        provider="qoder"
        title="Qoder Bulk GSuite Auto Login"
        serviceName="Qoder"
        onSuccess={onRefresh}
        onClose={() => setIsBulkOpen(false)}
      />
      <QoderSignupModal
        isOpen={isSignupOpen}
        onSuccess={onRefresh}
        onClose={() => setIsSignupOpen(false)}
      />
      <OAuthModal
        isOpen={isOAuthOpen}
        provider="qoder"
        providerInfo={providerInfo}
        onSuccess={() => {
          onRefresh?.();
          setIsOAuthOpen(false);
        }}
        onClose={() => setIsOAuthOpen(false)}
      />
    </>
  );
}

function FreebuffAutomationPanel({ providerInfo, onRefresh }) {
  const [isBulkOpen, setIsBulkOpen] = useState(false);

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <button type="button" onClick={() => setIsBulkOpen(true)} className="text-left">
          <Card
            hover
            padding="md"
            icon="key"
            title="Import API Keys"
            subtitle="Paste freebuff authTokens (email|authToken per line) from device-code approve flow. API key = authToken."
          />
        </button>
      </div>
      <BulkAccountAutomationModal
        isOpen={isBulkOpen}
        provider="freebuff"
        title="Freebuff Bulk Import"
        serviceName="Freebuff"
        onSuccess={onRefresh}
        onClose={() => setIsBulkOpen(false)}
      />
    </>
  );
}

function TokenHarborAutomationPanel({ onRefresh }) {
  const [isSignupOpen, setIsSignupOpen] = useState(false);

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <button type="button" onClick={() => setIsSignupOpen(true)} className="text-left">
          <Card
            hover
            padding="md"
            icon="redeem"
            title="Signup Bulk (chain reff + $5)"
            subtitle="Register new Token Harbor accounts with fresh YYDS inboxes: signup → verify email → claim $5 → API key → invite code chain ($2/referral)."
          />
        </button>
      </div>
      <TokenHarborSignupModal
        isOpen={isSignupOpen}
        onSuccess={onRefresh}
        onClose={() => setIsSignupOpen(false)}
      />
    </>
  );
}

function BasetenAutomationPanel({ onRefresh }) {
  const [isSignupOpen, setIsSignupOpen] = useState(false);

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <button type="button" onClick={() => setIsSignupOpen(true)} className="text-left">
          <Card
            hover
            padding="md"
            icon="deployed_code"
            title="Signup Bulk (YYDS + API key)"
            subtitle="Register new Baseten accounts with fresh YYDS inboxes: Camoufox signup (Cloudflare) → OTP → waiting room approve → API key saved as connection."
          />
        </button>
      </div>
      <BasetenSignupModal
        isOpen={isSignupOpen}
        onSuccess={onRefresh}
        onClose={() => setIsSignupOpen(false)}
      />
    </>
  );
}

function AutoclawAutomationPanel({ onRefresh }) {
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [isBulkOpen, setIsBulkOpen] = useState(false);
  const [isSignupOpen, setIsSignupOpen] = useState(false);

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <button type="button" onClick={() => setIsSignupOpen(true)} className="text-left">
          <Card
            hover
            padding="md"
            icon="person_add"
            title="Signup Bulk (Z.ai + YYDS)"
            subtitle="Register new AutoClaw accounts via Z.ai signup with fresh YYDS inboxes: signup → Aliyun slider → verify email → tokens saved as connection."
          />
        </button>
        <button type="button" onClick={() => setIsBulkOpen(true)} className="text-left">
          <Card
            hover
            padding="md"
            icon="group_add"
            title="Auto Login Bulk"
            subtitle="Run bulk gmail|password automation via Google OAuth for AutoClaw."
          />
        </button>
        <button type="button" onClick={() => setIsImportOpen(true)} className="text-left">
          <Card
            hover
            padding="md"
            icon="token"
            title="Import Account"
            subtitle="Paste access_token + refresh_token from autoclaw.z.ai (Google OAuth interception)."
          />
        </button>
      </div>

      <BulkAccountAutomationModal
        isOpen={isBulkOpen}
        provider="autoclaw"
        title="AutoClaw Bulk Auto Login"
        serviceName="AutoClaw"
        onSuccess={onRefresh}
        onClose={() => setIsBulkOpen(false)}
      />

      <AutoclawAutomationModal
        isOpen={isImportOpen}
        onClose={() => setIsImportOpen(false)}
        onSaved={() => onRefresh?.()}
      />

      <AutoclawSignupModal
        isOpen={isSignupOpen}
        onSuccess={onRefresh}
        onClose={() => setIsSignupOpen(false)}
      />
    </>
  );
}

function OutlookAutomationPanel({ onRefresh }) {
  const [isSignupOpen, setIsSignupOpen] = useState(false);

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <button type="button" onClick={() => setIsSignupOpen(true)} className="text-left">
          <Card
            hover
            padding="md"
            icon="mail"
            title="Signup Bulk (stealth browser)"
            subtitle="Register new Microsoft/Outlook accounts via Patchright stealth: PerimeterX press-and-hold → Arkose FunCaptcha → device challenge (YYDS + SMS) → Graph OAuth refresh token saved as connection."
          />
        </button>
      </div>

      <OutlookSignupModal
        isOpen={isSignupOpen}
        onSuccess={onRefresh}
        onClose={() => setIsSignupOpen(false)}
      />
    </>
  );
}

function ChatGptAutomationPanel({ onRefresh }) {
  const [isSignupOpen, setIsSignupOpen] = useState(false);

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <button type="button" onClick={() => setIsSignupOpen(true)} className="text-left">
          <Card
            hover
            padding="md"
            icon="chat"
            title="Signup Bulk (Go binary)"
            subtitle="Register new ChatGPT accounts via verssache/chatgpt-creator: TLS fingerprint spoofing + pluggable temp-mail (YYDS/Tempik/Driftz) → OTP verify → account saved as connection. Needs residential proxy."
          />
        </button>
      </div>

      <ChatGptSignupModal
        isOpen={isSignupOpen}
        onSuccess={onRefresh}
        onClose={() => setIsSignupOpen(false)}
      />
    </>
  );
}

function CloudflareAutomationPanel({ onRefresh }) {
  const [isTokenOpen, setIsTokenOpen] = useState(false);

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <button type="button" onClick={() => setIsTokenOpen(true)} className="text-left">
          <Card
            hover
            padding="md"
            icon="vpn_key"
            title="Import Existing Token"
            subtitle="Paste apiToken|accountId to verify the token, test Workers AI access, and save the connection. No browser needed."
          />
        </button>
      </div>

      <CloudflareTokenImportModal
        isOpen={isTokenOpen}
        onSuccess={onRefresh}
        onClose={() => setIsTokenOpen(false)}
      />
    </>
  );
}

function GrokAutomationPanel({ onRefresh }) {
  const [isRegisterOpen, setIsRegisterOpen] = useState(false);
  const [isSsoOpen, setIsSsoOpen] = useState(false);

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <button type="button" onClick={() => setIsRegisterOpen(true)} className="text-left">
          <Card
            hover
            padding="md"
            icon="person_add"
            title="Auto Register"
            subtitle="Temp-email signup → CPA device OAuth mint → save grok-cli only. No grok-web. Python: python -m grokreg --enable-cpa."
          />
        </button>
        <button type="button" onClick={() => setIsSsoOpen(true)} className="text-left">
          <Card
            hover
            padding="md"
            icon="login"
            title="Import SSO"
            subtitle="Bulk paste email|password|sso → CPA mint → save grok-cli OAuth. Job progress like Auto Register."
          />
        </button>
      </div>
      <GrokRegisterModal
        isOpen={isRegisterOpen}
        onSuccess={onRefresh}
        onClose={() => setIsRegisterOpen(false)}
      />
      <GrokSsoImportModal
        isOpen={isSsoOpen}
        onClose={() => setIsSsoOpen(false)}
        onSuccess={onRefresh}
      />
    </>
  );
}

const AUTOMATION_PROVIDERS = [
  {
    id: "kiro",
    label: "Kiro AI",
    icon: "psychology_alt",
    description: "Token import, bulk import, and social login automation.",
    supportedModes: ["single-token", "bulk-token", "bulk-account", "social"],
    component: KiroAutomationPanel,
  },
  {
    id: "codebuddy-intl",
    label: "CodeBuddy",
    icon: "smart_toy",
    description: "Bulk GSuite automation and browser OAuth polling login.",
    supportedModes: ["bulk-account", "device-oauth"],
    component: CodeBuddyAutomationPanel,
  },
  {
    id: "codebuddy-cn",
    label: "CodeBuddy CN",
    icon: "smart_toy",
    description: "5sim phone OTP automation and generated API key import.",
    supportedModes: ["phone-otp", "api-key", "proxy-pool"],
    component: CodeBuddyCnAutomationPanel,
  },
  {
    id: "qoder",
    label: "Qoder",
    icon: "code",
    description: "Bulk GSuite auto login via Google SSO and device flow.",
    supportedModes: ["bulk-account", "device-oauth"],
    component: QoderAutomationPanel,
  },
  {
    id: "freebuff",
    label: "Freebuff",
    icon: "bolt",
    description: "Import freebuff authTokens (API keys) from device-code approve flow. Models: GPT-5.6 Luna, GLM-5.2, Gemini 3.1 Pro.",
    supportedModes: ["import-token"],
    component: FreebuffAutomationPanel,
  },
  {
    id: "autoclaw",
    label: "AutoClaw",
    icon: "smart_toy",
    iconSrc: "/providers/autoclaw.webp?v=2",
    description: "Import AutoClaw access tokens or run bulk Google OAuth login. Tracks point balance + auto-refreshes tokens.",
    supportedModes: ["import-token", "bulk-account"],
    component: AutoclawAutomationPanel,
  },
  {
    id: "tokenharbor",
    label: "Token Harbor",
    icon: "redeem",
    description: "Bulk signup with chain referral: fresh YYDS inboxes → verify email → $5 credit → API key → invite code chain.",
    supportedModes: ["signup", "chain-referral"],
    component: TokenHarborAutomationPanel,
  },
  {
    id: "outlook",
    label: "Outlook",
    icon: "mail",
    description: "Bulk Microsoft/Outlook signup via stealth browser: PerimeterX press-and-hold → Arkose FunCaptcha → device challenge → Graph OAuth token.",
    supportedModes: ["signup"],
    component: OutlookAutomationPanel,
  },
  {
    id: "chatgpt",
    label: "ChatGPT",
    icon: "chat",
    description: "Bulk ChatGPT signup via Go binary (TLS spoof + temp-mail OTP). Needs residential proxy (OpenAI blocks datacenter IPs).",
    supportedModes: ["signup"],
    component: ChatGptAutomationPanel,
  },
  {
    id: "baseten",
    label: "Baseten",
    icon: "deployed_code",
    description: "Bulk signup with YYDS temp mail: Camoufox signup → OTP → waiting room approve → API key → saved as Baseten connection.",
    supportedModes: ["signup"],
    component: BasetenAutomationPanel,
  },
  {
    id: "cloudflare-ai",
    label: "Cloudflare AI",
    icon: "cloud",
    description: "Register/login via Google, create Workers AI API tokens, verify access, and import existing tokens.",
    supportedModes: ["google-register", "cloudflare-login", "token-import", "workers-ai-test", "bluk-cf-import"],
    component: CloudflareAutomationPanel,
  },
  {
    id: "grok-cli",
    label: "Grok CLI",
    icon: "smart_toy",
    iconSrc: "/providers/grok-cli.webp",
    description: "xAI Grok auto-register → CPA mint → grok-cli OAuth. Or import existing SSO (email/password/sso) → mint.",
    supportedModes: ["auto-register", "import-sso", "cpa-mint"],
    component: GrokAutomationPanel,
  },
];

function TabIcon({ provider, className = "" }) {
  const iconPath = provider.iconSrc || `/providers/${provider.id}.webp`;
  return (
    <div
      className="size-8 shrink-0 rounded-lg flex items-center justify-center"
      style={{
        backgroundColor: `${(provider.color || "#6B7280").length > 7 ? provider.color : (provider.color || "#6B7280") + "15"}`,
      }}
    >
      <ProviderIcon
        src={iconPath}
        alt={provider.label}
        size={30}
        className={`object-contain rounded-lg max-w-[32px] max-h-[32px] ${className}`}
        fallbackText={provider.label?.[0]}
        fallbackColor={provider.color}
      />
    </div>
  );
}

const AUTOMATION_PROVIDER_STORAGE_KEY = "automation.activeProviderId";

function getInitialAutomationProviderId() {
  if (typeof window === "undefined") return AUTOMATION_PROVIDERS[0].id;
  try {
    const saved = window.localStorage.getItem(AUTOMATION_PROVIDER_STORAGE_KEY);
    if (AUTOMATION_PROVIDERS.some((provider) => provider.id === saved)) return saved;
  } catch {
    // ignore storage errors
  }
  return AUTOMATION_PROVIDERS[0].id;
}

export default function AutomationPage() {
  const [connections, setConnections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeProviderId, setActiveProviderId] = useState(getInitialAutomationProviderId);

  const fetchConnections = useCallback(async () => {
    try {
      const res = await fetch("/api/providers", { cache: "no-store" });
      const data = await res.json();
      if (res.ok) setConnections(data.connections || []);
    } catch (error) {
      console.log("Error fetching automation connections:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount-only data fetch
    fetchConnections();
  }, [fetchConnections]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const requestedProvider = new URLSearchParams(window.location.search).get("provider");
    if (AUTOMATION_PROVIDERS.some((provider) => provider.id === requestedProvider)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time URL→state sync on mount
      setActiveProviderId(requestedProvider);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(AUTOMATION_PROVIDER_STORAGE_KEY, activeProviderId);
    } catch {
      // ignore storage errors
    }
  }, [activeProviderId]);

  const activeProvider = AUTOMATION_PROVIDERS.find((provider) => provider.id === activeProviderId) || AUTOMATION_PROVIDERS[0];
  const providerInfo = FREE_PROVIDERS[activeProvider.id] || { id: activeProvider.id, name: activeProvider.label };
  const ProviderPanel = activeProvider.component;
  const providerCounts = useMemo(() => {
    const counts = {};
    for (const provider of AUTOMATION_PROVIDERS) {
      counts[provider.id] = connections.filter((connection) => connection.provider === provider.id).length;
    }
    return counts;
  }, [connections]);

  if (loading) {
    return (
      <div className="flex flex-col gap-6">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Automation</h1>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {AUTOMATION_PROVIDERS.map((provider) => {
          const selected = provider.id === activeProviderId;
          return (
            <button
              key={provider.id}
              type="button"
              onClick={() => setActiveProviderId(provider.id)}
              className={`flex min-w-0 items-center gap-3 rounded-lg border px-4 py-3 text-left transition-colors ${
                selected
                  ? "border-primary/50 bg-primary/10 text-primary"
                  : "border-border bg-surface text-text-main hover:border-primary/30 hover:bg-primary/5"
              }`}
            >
              <TabIcon provider={provider} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">{provider.label}</span>
                <span className="mt-0.5 block text-xs text-text-muted">
                  {getConnectionLabel(providerCounts[provider.id] || 0)}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      <Card>
        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <TabIcon provider={activeProvider} className="text-primary" />
                <h2 className="text-lg font-semibold">{activeProvider.label}</h2>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {activeProvider.supportedModes.map((mode) => (
                  <Badge key={mode} variant="default" size="sm">
                    {mode}
                  </Badge>
                ))}
              </div>
            </div>
            <Badge variant="success">{getConnectionLabel(providerCounts[activeProvider.id] || 0)}</Badge>
          </div>

          <ProviderPanel providerInfo={providerInfo} onRefresh={fetchConnections} />
        </div>
      </Card>

      <AutomationHistoryPanel />
    </div>
  );
}
