// Clear a provider/model cooldown and, when the connection was marked
// unavailable because of that same failure, put it back in rotation.
//
// One implementation because two URLs mean the same thing: the dashboard's
// POST /api/models/availability {action:"clearCooldown"} and the go-parity
// POST /admin/health/reset?provider=&model=.

import { getProviderConnections, updateProviderConnection } from "@/lib/localDb";

const MODEL_LOCK_PREFIX = "modelLock_";

export async function clearModelCooldown(provider, model) {
  if (!provider || !model) {
    throw new Error("provider and model are required");
  }

  const connections = await getProviderConnections({ provider });
  const lockKey = `${MODEL_LOCK_PREFIX}${model}`;

  await Promise.all(
    connections.reduce((acc, connection) => {
      if (!connection[lockKey]) return acc;
      acc.push(
        updateProviderConnection(connection.id, {
          [lockKey]: null,
          ...(connection.testStatus === "unavailable"
            ? { testStatus: "active", lastError: null, lastErrorAt: null, backoffLevel: 0 }
            : {}),
        })
      );
      return acc;
    }, [])
  );

  return { cleared: connections.filter((c) => c[lockKey]).length };
}

// "Everything for this provider" — every active model lock plus any
// unavailable flag. Used when the dashboard resets a whole provider.
export async function clearProviderCooldowns(provider) {
  if (!provider) throw new Error("provider is required");
  const connections = await getProviderConnections({ provider });
  let cleared = 0;

  await Promise.all(
    connections.map(async (connection) => {
      const patch = {};
      for (const key of Object.keys(connection)) {
        if (key.startsWith(MODEL_LOCK_PREFIX) && connection[key]) patch[key] = null;
      }
      if (connection.testStatus === "unavailable") {
        Object.assign(patch, { testStatus: "active", lastError: null, lastErrorAt: null, backoffLevel: 0 });
      }
      if (!Object.keys(patch).length) return;
      cleared++;
      await updateProviderConnection(connection.id, patch);
    })
  );

  return { cleared };
}
