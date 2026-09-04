// Shim → re-export from new SQLite-based DB layer (src/lib/db/)
// Kept for backward compatibility with existing imports.
export {
  getSettings, updateSettings, isCloudEnabled, getCloudUrl,
  getProviderConnections, getProviderConnectionById,
  createProviderConnection, createProviderConnectionsBulk, updateProviderConnection,
  deleteProviderConnection, deleteProviderConnectionsByProvider,
  reorderProviderConnections, cleanupProviderConnections,
  getProviderNodes, getProviderNodeById,
  createProviderNode, updateProviderNode, deleteProviderNode,
  getProxyPools, getProxyPoolById,
  createProxyPool, updateProxyPool, deleteProxyPool,
  listProxyPoolFitness, upsertProxyPoolFitness,
  deleteProxyPoolFitness, clearProxyPoolFitness, deleteProxyPoolFitnessByPool,
  getApiKeys, getApiKeyById, createApiKey, updateApiKey, deleteApiKey, validateApiKey,
} from "@/lib/db/index.js";
export {
  checkApiKeyLimits, recordApiKeyUsage, getApiKeyUsageSnapshot,
} from "@/lib/db/repos/apiKeyUsageRepo.js";
export {
  getCombos, getComboById, getComboByName,
  createCombo, updateCombo, deleteCombo,
  getModelAliases, setModelAlias, deleteModelAlias,
  getCustomModels, addCustomModel, addCustomModelsBulk, deleteCustomModel,
  getMitmAlias, setMitmAliasAll,
  getPricing, getPricingForModel, updatePricing, resetPricing, resetAllPricing,
  getCachedProviderModels, saveCachedProviderModels, clearCachedProviderModels,
  exportDb, importDb,
} from "@/lib/db/index.js";
