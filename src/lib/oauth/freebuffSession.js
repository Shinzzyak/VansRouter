import { getProviderConnections, getProviderConnectionById } from "@/lib/db";
import {
  readFreebuffSession,
  switchFreebuffModel,
  clearFreebuffSessionsForToken,
} from "open-sse/executors/freebuff.js";

// Dashboard Freebuff session surface (9router-go parity).
//
// The dashboard asks about ONE account at a time, so every entry point resolves
// a connection first: by id when the caller names one, otherwise the
// highest-priority active Freebuff connection — the same row a chat request
// would pick.

// Device-flow rows carry the bearer token under authToken / accessToken / apiKey;
// manually imported rows may hold only one of them.
export function freebuffConnectionToken(conn) {
  if (!conn) return "";
  return conn.authToken || conn.accessToken || conn.apiKey || "";
}

export async function resolveFreebuffConnection(connectionId) {
  if (connectionId) return (await getProviderConnectionById(connectionId)) || null;
  const conns = await getProviderConnections({ provider: "freebuff", isActive: true });
  return conns[0] || null;
}

// Every response carries the account it describes, so the dashboard names the
// connection instead of reporting a status that belongs to whichever account
// happened to be first.
function withConnection(conn, fields) {
  const resp = { ...fields };
  if (conn) {
    resp.connectionId = conn.id;
    if (conn.name) resp.connectionName = conn.name;
    if (conn.email) resp.connectionEmail = conn.email;
  }
  return resp;
}

export async function freebuffSessionStatus(connectionId) {
  const conn = await resolveFreebuffConnection(connectionId);
  if (!conn) return withConnection(null, { status: "none" });
  const token = freebuffConnectionToken(conn);
  if (!token) return withConnection(conn, { status: "none" });
  return withConnection(conn, await readFreebuffSession(token));
}

export async function freebuffSessionSwitch({ connectionId, model } = {}) {
  const wanted = String(model || "").trim();
  if (!wanted) return { error: "missing model", status: 400 };

  const conn = await resolveFreebuffConnection(connectionId);
  if (!conn) return { error: "freebuff connection not found", status: 404 };

  const token = freebuffConnectionToken(conn);
  if (!token) return { error: "freebuff connection has no auth token", status: 400 };

  const current = await readFreebuffSession(token);
  // Already on the requested model: release nothing, so a click on the current
  // row cannot burn a fresh seat.
  if (current.status === "active" && current.currentModel === wanted) {
    return withConnection(conn, {
      status: "active",
      currentModel: current.currentModel,
      instanceId: current.instanceId,
      expiresAt: current.expiresAt,
      switched: false,
    });
  }

  const result = await switchFreebuffModel(token, wanted, { instanceId: current.instanceId || "" });
  return withConnection(conn, {
    status: "active",
    currentModel: result.model,
    instanceId: result.instanceId,
    expiresAt: result.expiresAt,
    switched: true,
    ...(result.freebucksRefund > 0 ? { freebucksRefund: result.freebucksRefund } : {}),
  });
}

export { clearFreebuffSessionsForToken };
