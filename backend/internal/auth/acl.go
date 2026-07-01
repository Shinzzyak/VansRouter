package auth

import (
	"slices"
	"strings"

	"github.com/9router/9router/backend/internal/db/repos"
	"github.com/9router/9router/backend/internal/providers"
)

const (
	openAICompatiblePrefix   = "openai-compatible-"
	anthropicCompatiblePrefix = "anthropic-compatible-"
	customEmbeddingPrefix    = "custom-embedding-"
)

// IsProviderAllowed reports whether the API key may use the given provider.
// nil allow-list means all allowed; empty means none allowed.
// It mirrors src/sse/services/auth.js including alias resolution and the
// custom-compatible-provider prefix fix.
func IsProviderAllowed(key *repos.APIKey, registry *providers.Registry, providerID, customPrefix string) bool {
	if key == nil {
		return true
	}
	allowed := key.AllowedProviders
	if allowed == nil {
		return true
	}
	if len(allowed) == 0 {
		return false
	}
	if slices.Contains(allowed, providerID) {
		return true
	}
	alias := providers.ResolveAlias(registry, providerID)
	if alias != providerID && slices.Contains(allowed, alias) {
		return true
	}
	resolved := providers.ResolveProviderId(registry, providerID)
	if resolved != providerID && slices.Contains(allowed, resolved) {
		return true
	}
	if isCustomCompatible(providerID) && customPrefix != "" && slices.Contains(allowed, customPrefix) {
		return true
	}
	return false
}

// IsComboAllowed reports whether the API key may use the given combo.
func IsComboAllowed(key *repos.APIKey, comboName string) bool {
	if key == nil {
		return true
	}
	allowed := key.AllowedCombos
	if allowed == nil {
		return true
	}
	if len(allowed) == 0 {
		return false
	}
	name := strings.TrimPrefix(comboName, "combo/")
	return slices.Contains(allowed, name)
}

// IsKindAllowed reports whether the API key may use the given request kind.
func IsKindAllowed(key *repos.APIKey, kind string) bool {
	if key == nil {
		return true
	}
	allowed := key.AllowedKinds
	if allowed == nil {
		return true
	}
	if len(allowed) == 0 {
		return false
	}
	return slices.Contains(allowed, kind)
}

func isCustomCompatible(providerID string) bool {
	return strings.HasPrefix(providerID, openAICompatiblePrefix) ||
		strings.HasPrefix(providerID, anthropicCompatiblePrefix) ||
		strings.HasPrefix(providerID, customEmbeddingPrefix)
}
