"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Badge from "./Badge";
import Button from "./Button";
import Input from "./Input";
import Modal from "./Modal";
import { readJsonResponse } from "@/shared/utils/httpResponse.js";

const PROVIDER = "chatgpt-signup";
const ACTIVE_JOB_STATUSES = new Set(["queued", "running", "needs_manual"]);
const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "cancelled"]);
const STORAGE_KEY = "chatgpt-signup-active-job";

function getStatusVariant(status) {
  if (status === "success" || status === "completed") return "success";
  if (status === "needs_manual") return "warning";
  if (status === "running" || status === "queued") return "info";
  if (status === "cancelled") return "default";
  return "danger";
}

function formatStepLabel(value) {
  return String(value || "waiting").replaceAll("_", " ");
}

async function fetchJob(jobId) {
  const res = await fetch(`/api/oauth/${PROVIDER}/bulk-import/${jobId}`, { cache: "no-store" });
  const data = await readJsonResponse(res, "Failed to fetch job");
  return { res, data };
}

export default function ChatGptSignupModal({ isOpen, onClose, onSuccess }) {
  const [accountCount, setAccountCount] = useState("1");
  const [concurrency, setConcurrency] = useState("1");
  const [proxyUrl, setProxyUrl] = useState("");
  const [tempMailApi, setTempMailApi] = useState("https://maliapi.215.im/v1");
  const [tempMailToken, setTempMailToken] = useState("");
  const [activeJob, setActiveJob] = useState(null);
  const [error, setError] = useState(null);
  const [starting, setStarting] = useState(false);
  const completedRefreshRef = useRef(new Set());

  const runningJob = activeJob && ACTIVE_JOB_STATUSES.has(activeJob.status);
  const finishedJob = activeJob && TERMINAL_JOB_STATUSES.has(activeJob.status);

  const resetState = useCallback(() => {
    setActiveJob(null);
    setError(null);
    setStarting(false);
    if (typeof window !== "undefined") localStorage.removeItem(STORAGE_KEY);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    (async () => {
      try {
        const stored =
          typeof window !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
        if (stored) {
          const { res, data } = await fetchJob(stored);
          if (!cancelled && res.ok && data?.job && ACTIVE_JOB_STATUSES.has(data.job.status)) {
            setActiveJob(data.job);
            return;
          }
        }
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !activeJob?.jobId || finishedJob) return;
    const interval = setInterval(async () => {
      try {
        const { res, data } = await fetchJob(activeJob.jobId);
        if (res.ok && data?.job) {
          setActiveJob(data.job);
          if (typeof window !== "undefined") localStorage.setItem(STORAGE_KEY, data.job.jobId);
          if (
            TERMINAL_JOB_STATUSES.has(data.job.status) &&
            !completedRefreshRef.current.has(data.job.jobId)
          ) {
            completedRefreshRef.current.add(data.job.jobId);
            onSuccess?.();
          }
        }
      } catch {
        /* ignore */
      }
    }, 2500);
    return () => clearInterval(interval);
  }, [activeJob?.jobId, finishedJob, isOpen, onSuccess]);

  const handleStart = async () => {
    setStarting(true);
    setError(null);
    try {
      const count = Number.parseInt(accountCount, 10) || 1;
      const res = await fetch(`/api/oauth/${PROVIDER}/bulk-import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "signup",
          registerCount: count,
          concurrency: Number.parseInt(concurrency, 10) || 1,
          proxyUrl: proxyUrl.trim() || undefined,
          tempMailApi: tempMailApi.trim() || undefined,
          tempMailToken: tempMailToken.trim() || undefined,
        }),
      });
      const data = await readJsonResponse(res, "Failed to start ChatGPT signup job");
      if (!res.ok || data.error) throw new Error(data.error || "Failed to start job");
      setActiveJob(data.job || null);
      if (data.job?.jobId) {
        completedRefreshRef.current.delete(data.job.jobId);
        if (typeof window !== "undefined") localStorage.setItem(STORAGE_KEY, data.job.jobId);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setStarting(false);
    }
  };

  const handleCancel = async () => {
    if (!activeJob?.jobId) return;
    try {
      const res = await fetch(`/api/oauth/${PROVIDER}/bulk-import/${activeJob.jobId}/cancel`, {
        method: "POST",
      });
      const data = await readJsonResponse(res, "Failed to cancel");
      if (!res.ok || data.error) throw new Error(data.error || "Cancel failed");
      if (data.job) setActiveJob(data.job);
    } catch (err) {
      setError(err.message);
    }
  };

  const groupedAccounts = (activeJob?.accounts || []).reduce((acc, a) => {
    const key = a.status || "unknown";
    if (!acc[key]) acc[key] = [];
    acc[key].push(a);
    return acc;
  }, {});

  return (
    <Modal
      isOpen={isOpen}
      title="ChatGPT Signup Bulk (Go binary)"
      onClose={onClose}
      size="full"
      className="max-w-[min(96vw,1100px)]"
    >
      <div className="flex flex-col gap-4">
        {!activeJob && (
          <>
            <div className="rounded-lg border border-border bg-surface p-3 text-sm text-text-muted">
              Register new ChatGPT accounts via{" "}
              <code className="rounded bg-background px-1">verssache/chatgpt-creator</code> Go binary
              (TLS fingerprint spoofing + pluggable temp-mail backend — YYDS/Tempik/Driftz). Flow:
              homepage → CSRF → register → OTP via temp-mail → create account. Accounts saved as
              ChatGPT connections (email + password). Needs the Go binary at{" "}
              <code className="rounded bg-background px-1">/opt/chatgpt-creator/chatgptreg</code> and
              a residential proxy (OpenAI blocks datacenter IPs with 403).
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Input
                label="Accounts to register"
                type="number"
                min={1}
                value={accountCount}
                onChange={(e) => setAccountCount(e.target.value)}
              />
              <Input
                label="Concurrency"
                type="number"
                min={1}
                value={concurrency}
                onChange={(e) => setConcurrency(e.target.value)}
              />
              <Input
                label="Proxy (http://user:pass@host:port — wajib untuk OpenAI)"
                value={proxyUrl}
                onChange={(e) => setProxyUrl(e.target.value)}
                placeholder="http://user:pass@host:port"
              />
              <Input
                label="Temp-mail API base (YYDS)"
                value={tempMailApi}
                onChange={(e) => setTempMailApi(e.target.value)}
                placeholder="https://maliapi.215.im/v1"
              />
              <Input
                label="Temp-mail token (YYDS AC-...)"
                value={tempMailToken}
                onChange={(e) => setTempMailToken(e.target.value)}
                placeholder="AC-..."
              />
            </div>

            {error && (
              <p className="text-sm text-red-500" role="alert">
                {error}
              </p>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={onClose}>
                Close
              </Button>
              <Button variant="primary" loading={starting} onClick={handleStart}>
                Start signup
              </Button>
            </div>
          </>
        )}

        {activeJob && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={getStatusVariant(activeJob.status)}>
                {formatStepLabel(activeJob.status)}
              </Badge>
              <span className="text-xs text-text-muted">job {activeJob.jobId}</span>
              {runningJob && (
                <Button size="sm" variant="danger" onClick={handleCancel}>
                  Cancel
                </Button>
              )}
              {finishedJob && (
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => {
                    resetState();
                    onSuccess?.();
                  }}
                >
                  Done
                </Button>
              )}
              {finishedJob && (
                <Button size="sm" variant="secondary" onClick={resetState}>
                  New job
                </Button>
              )}
            </div>

            {error && (
              <p className="text-sm text-red-500" role="alert">
                {error}
              </p>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              {Object.entries(groupedAccounts).map(([status, accounts]) => (
                <div key={status} className="rounded-lg border border-border p-3">
                  <div className="mb-2 flex items-center gap-2">
                    <Badge variant={getStatusVariant(status)} size="sm">
                      {formatStepLabel(status)}
                    </Badge>
                    <span className="text-xs text-text-muted">{accounts.length}</span>
                  </div>
                  <ul className="max-h-48 space-y-1 overflow-auto text-xs">
                    {accounts.map((a) => (
                      <li key={a.line} className="truncate text-text-muted">
                        #{a.line} {a.email || ""} · {formatStepLabel(a.currentStep || a.status)}
                        {a.error ? ` — ${a.error}` : ""}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>

            <div className="max-h-56 overflow-auto rounded-lg border border-border bg-background p-2 font-mono text-[11px] text-text-muted">
              {(activeJob.activity || [])
                .slice(-40)
                .reverse()
                .map((item, i) => (
                  <div key={i}>
                    {item.at || item.time || ""} {item.message || item.step || JSON.stringify(item)}
                  </div>
                ))}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
