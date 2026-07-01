// Package models builds the OpenAI-compatible /v1/models list and checks
// model allow-lists. It mirrors src/sse/services/allowedModels.js but is
// driven by the JSON provider registry and a Source interface so the DB
// layer is pluggable and testable.
package models

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/9router/9router/backend/internal/providers"
)

// Kind is the request/service kind used to filter model entries.
type Kind string

const (
	KindLLM       Kind = "llm"
	KindTTS       Kind = "tts"
	KindEmbedding Kind = "embedding"
	KindImage     Kind = "image"
	KindImageToText Kind = "imageToText"
	KindSTT       Kind = "stt"
	KindWebSearch Kind = "webSearch"
	KindWebFetch  Kind = "webFetch"
)

// AllKinds is the default kind filter used by isModelAllowed.
var AllKinds = []Kind{KindLLM, KindTTS, KindEmbedding, KindImage, KindImageToText, KindSTT, KindWebSearch, KindWebFetch}

// Model is the OpenAI-compatible /v1/models entry.
type Model struct {
	ID      string `json:"id"`
	Object  string `json:"object"`
	OwnedBy string `json:"owned_by"`
	Kind    string `json:"kind,omitempty"`
}

// Combo is a DB-backed combo entry.
type Combo struct {
	ID     string   `json:"id"`
	Name   string   `json:"name"`
	Kind   string   `json:"kind"`
	Models []string `json:"models"`
}

// Connection is an active provider connection.
type Connection struct {
	Provider string
	Alias    string
	Data     map[string]any
}

// CustomModel is a DB-backed user-defined model.
type CustomModel struct {
	ID            string `json:"id"`
	ProviderAlias string `json:"providerAlias"`
	Type          string `json:"type"`
}

// Source supplies DB-backed model data to the builder. It is an interface
// so tests can inject in-memory fakes without touching SQLite.
type Source interface {
	Combos(ctx context.Context) ([]Combo, error)
	Connections(ctx context.Context) ([]Connection, error)
	CustomModels(ctx context.Context) ([]CustomModel, error)
	ModelAliases(ctx context.Context) (map[string]string, error)
	DisabledByAlias(ctx context.Context) (map[string][]string, error)
}

type registryModel struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Kind string `json:"kind"`
	Type string `json:"type"`
}

// modelKind returns the Kind for a registry model entry, mirroring the JS
// helper that prefers model.kind then maps model.type then defaults to llm.
func modelKind(m registryModel) Kind {
	if m.Kind != "" {
		return Kind(m.Kind)
	}
	switch m.Type {
	case "image":
		return KindImage
	case "tts":
		return KindTTS
	case "embedding":
		return KindEmbedding
	case "stt":
		return KindSTT
	case "imageToText":
		return KindImageToText
	}
	return KindLLM
}

// inferKindFromUnknownModelId mirrors the JS regex-based fallback.
func inferKindFromUnknownModelId(modelID string) Kind {
	lower := strings.ToLower(modelID)
	switch {
	case strings.Contains(lower, "embed"):
		return KindEmbedding
	case strings.Contains(lower, "tts"), strings.Contains(lower, "speech"),
		strings.Contains(lower, "audio"), strings.Contains(lower, "voice"):
		return KindTTS
	case strings.Contains(lower, "image"), strings.Contains(lower, "imagen"),
		strings.Contains(lower, "dall-e"), strings.Contains(lower, "dalle"),
		strings.Contains(lower, "flux"), strings.Contains(lower, "sdxl"),
		strings.Contains(lower, "sd-"), strings.Contains(lower, "stable-diffusion"):
		return KindImage
	}
	return KindLLM
}

// providerMatchesKinds returns true when the provider advertises any of the
// requested kinds. Providers without serviceKinds default to llm.
func providerMatchesKinds(p providers.Provider, kinds map[Kind]struct{}) bool {
	providerKinds := p.ServiceKinds
	if len(providerKinds) == 0 {
		_, ok := kinds[KindLLM]
		return ok
	}
	for _, k := range providerKinds {
		if _, ok := kinds[Kind(k)]; ok {
			return true
		}
	}
	return false
}

type entry struct {
	ID   string
	Kind string // only set for webSearch/webFetch pseudo-models
}

// Builder caches the model list for a short TTL so the /v1/models endpoint
// stays cheap. It is safe for concurrent use.
type Builder struct {
	registry *providers.Registry
	src      Source
	ttl      time.Duration

	mu       sync.RWMutex
	cache    map[string]struct{}
	cacheExp time.Time
}

// NewBuilder returns a Builder backed by the given registry and source.
func NewBuilder(reg *providers.Registry, src Source) *Builder {
	return &Builder{registry: reg, src: src, ttl: 30 * time.Second}
}

// InvalidateCache clears the cached allow-list.
func (b *Builder) InvalidateCache() {
	b.mu.Lock()
	b.cache = nil
	b.cacheExp = time.Time{}
	b.mu.Unlock()
}

// BuildModelsList returns the deduplicated OpenAI-compatible model list
// filtered to the given kinds. Pass nil for all kinds.
func (b *Builder) BuildModelsList(ctx context.Context, kindFilter []Kind) ([]Model, error) {
	combos, conns, customs, aliases, disabled, err := b.load(ctx)
	if err != nil {
		return nil, err
	}
	entries := b.buildEntries(kindFilter, combos, conns, customs, aliases, disabled)

	seen := make(map[string]struct{}, len(entries))
	out := make([]Model, 0, len(entries))
	for _, e := range entries {
		if e.ID == "" {
			continue
		}
		if _, dup := seen[e.ID]; dup {
			continue
		}
		seen[e.ID] = struct{}{}
		ownedBy := "combo"
		if i := strings.Index(e.ID, "/"); i >= 0 {
			ownedBy = e.ID[:i]
		}
		m := Model{ID: e.ID, Object: "model", OwnedBy: ownedBy}
		if e.Kind != "" {
			m.Kind = e.Kind
		}
		out = append(out, m)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

// IsModelAllowed reports whether modelStr is in the cached allow-list.
// A nil API key (internal/dashboard caller) always returns true.
func (b *Builder) IsModelAllowed(ctx context.Context, modelStr string, apiKeyPresent bool) (bool, error) {
	if !apiKeyPresent {
		return true, nil
	}
	allowed, err := b.cachedAllowList(ctx)
	if err != nil {
		return false, err
	}
	_, ok := allowed[modelStr]
	return ok, nil
}

func (b *Builder) cachedAllowList(ctx context.Context) (map[string]struct{}, error) {
	b.mu.RLock()
	if b.cache != nil && time.Now().Before(b.cacheExp) {
		c := b.cache
		b.mu.RUnlock()
		return c, nil
	}
	b.mu.RUnlock()

	combos, conns, customs, aliases, disabled, err := b.load(ctx)
	if err != nil {
		return nil, err
	}
	entries := b.buildEntries(AllKinds, combos, conns, customs, aliases, disabled)
	set := make(map[string]struct{}, len(entries))
	for _, e := range entries {
		if e.ID != "" {
			set[e.ID] = struct{}{}
		}
	}
	b.mu.Lock()
	b.cache = set
	b.cacheExp = time.Now().Add(b.ttl)
	b.mu.Unlock()
	return set, nil
}

func (b *Builder) load(ctx context.Context) ([]Combo, []Connection, []CustomModel, map[string]string, map[string][]string, error) {
	combos, err := b.src.Combos(ctx)
	if err != nil {
		return nil, nil, nil, nil, nil, fmt.Errorf("load combos: %w", err)
	}
	conns, err := b.src.Connections(ctx)
	if err != nil {
		return nil, nil, nil, nil, nil, fmt.Errorf("load connections: %w", err)
	}
	customs, err := b.src.CustomModels(ctx)
	if err != nil {
		return nil, nil, nil, nil, nil, fmt.Errorf("load custom models: %w", err)
	}
	aliases, err := b.src.ModelAliases(ctx)
	if err != nil {
		return nil, nil, nil, nil, nil, fmt.Errorf("load model aliases: %w", err)
	}
	disabled, err := b.src.DisabledByAlias(ctx)
	if err != nil {
		return nil, nil, nil, nil, nil, fmt.Errorf("load disabled models: %w", err)
	}
	return combos, conns, customs, aliases, disabled, nil
}

func (b *Builder) buildEntries(
	kindFilter []Kind,
	combos []Combo,
	conns []Connection,
	customs []CustomModel,
	modelAliases map[string]string,
	disabled map[string][]string,
) []entry {
	kinds := make(map[Kind]struct{}, len(kindFilter))
	for _, k := range kindFilter {
		kinds[k] = struct{}{}
	}
	if len(kinds) == 0 {
		for _, k := range AllKinds {
			kinds[k] = struct{}{}
		}
	}

	var entries []entry

	// Combos first.
	for _, c := range combos {
		kind := KindLLM
		if c.Kind != "" {
			kind = Kind(c.Kind)
		}
		if _, ok := kinds[kind]; !ok {
			continue
		}
		e := entry{ID: "combo/" + c.Name}
		if kind == KindWebSearch || kind == KindWebFetch {
			e.Kind = string(kind)
		}
		entries = append(entries, e)
	}

	// Build a quick lookup of active connections by provider id.
	activeByProvider := make(map[string]Connection, len(conns))
	for _, c := range conns {
		if _, exists := activeByProvider[c.Provider]; !exists {
			activeByProvider[c.Provider] = c
		}
	}

	// Providers from the registry, split into connected vs free.
	connected := make(map[string]struct{})
	for id := range activeByProvider {
		connected[id] = struct{}{}
	}

	// Connected providers: walk active connections.
	for providerID, conn := range activeByProvider {
		provider, ok := b.registry.Providers[providerID]
		if !ok {
			continue
		}
		if !providerMatchesKinds(provider, kinds) {
			continue
		}
		entries = append(entries, b.connectedEntries(provider, conn, kinds, customs, modelAliases, disabled)...)
	}

	// Free / noAuth providers not already connected.
	for providerID, provider := range b.registry.Providers {
		if _, ok := connected[providerID]; ok {
			continue
		}
		if !provider.NoAuth {
			continue
		}
		if !providerMatchesKinds(provider, kinds) {
			continue
		}
		entries = append(entries, b.freeEntries(provider, kinds, customs, modelAliases, disabled)...)
	}

	return entries
}

func (b *Builder) connectedEntries(
	provider providers.Provider,
	conn Connection,
	kinds map[Kind]struct{},
	customs []CustomModel,
	modelAliases map[string]string,
	disabled map[string][]string,
) []entry {
	var entries []entry
	alias := provider.Alias
	if alias == "" {
		alias = provider.ID
	}
	outputAlias := alias
	if prefix, ok := conn.Data["prefix"].(string); ok && prefix != "" {
		outputAlias = strings.TrimSpace(prefix)
	}

	staticModels := decodeRegistryModels(b.registry.PROVIDER_MODELS[alias])
	if staticModels == nil {
		staticModels = decodeRegistryModels(b.registry.PROVIDER_MODELS[provider.ID])
	}
	staticKindByID := make(map[string]Kind, len(staticModels))
	for _, m := range staticModels {
		staticKindByID[m.ID] = modelKind(m)
	}

	// Resolve the raw model id set: explicit enabledModels > registry models.
	var rawIDs []string
	if enabled, ok := conn.Data["enabledModels"].([]any); ok && len(enabled) > 0 {
		for _, v := range enabled {
			if s, ok := v.(string); ok && strings.TrimSpace(s) != "" {
				rawIDs = append(rawIDs, s)
			}
		}
	} else {
		for _, m := range staticModels {
			rawIDs = append(rawIDs, m.ID)
		}
	}

	// ponytail: live fetches for compatible providers and modelsFetcher are
	// deferred to Phase 3 — the registry alone covers the static-models path.

	// Strip alias prefixes.
	modelIDs := stripPrefixes(rawIDs, outputAlias, alias, provider.ID)

	// Custom models matching this provider.
	for _, m := range customs {
		if m.ID == "" {
			continue
		}
		if m.Type != "" && m.Type != "llm" {
			continue
		}
		if m.ProviderAlias != alias && m.ProviderAlias != outputAlias && m.ProviderAlias != provider.ID {
			continue
		}
		id := strings.TrimSpace(m.ID)
		if id != "" {
			modelIDs = append(modelIDs, id)
		}
	}

	// Aliases that point at this provider.
	for _, full := range modelAliases {
		id, ok := stripOnePrefix(full, outputAlias, alias, provider.ID)
		if ok && id != "" {
			modelIDs = append(modelIDs, id)
		}
	}

	merged := uniqueStrings(modelIDs)
	for _, id := range merged {
		k, ok := staticKindByID[id]
		if !ok {
			k = inferKindFromUnknownModelId(id)
		}
		if _, allowed := kinds[k]; !allowed {
			continue
		}
		if isDisabled(disabled, outputAlias, id) || isDisabled(disabled, alias, id) {
			continue
		}
		entries = append(entries, entry{ID: outputAlias + "/" + id})
	}

	// Sub-kind models (tts / embedding / web search / web fetch).
	entries = append(entries, subKindEntries(provider, outputAlias, kinds, disabled, false)...)
	return entries
}

func (b *Builder) freeEntries(
	provider providers.Provider,
	kinds map[Kind]struct{},
	customs []CustomModel,
	modelAliases map[string]string,
	disabled map[string][]string,
) []entry {
	var entries []entry
	alias := provider.Alias
	if alias == "" {
		alias = provider.ID
	}
	staticModels := decodeRegistryModels(b.registry.PROVIDER_MODELS[alias])
	if staticModels == nil {
		staticModels = decodeRegistryModels(b.registry.PROVIDER_MODELS[provider.ID])
	}
	staticKindByID := make(map[string]Kind, len(staticModels))
	for _, m := range staticModels {
		staticKindByID[m.ID] = modelKind(m)
	}

	var modelIDs []string
	for _, m := range staticModels {
		modelIDs = append(modelIDs, m.ID)
	}
	// ponytail: modelsFetcher live fetch deferred to Phase 3.

	for _, m := range customs {
		if m.ID == "" || (m.Type != "" && m.Type != "llm") {
			continue
		}
		if m.ProviderAlias != alias && m.ProviderAlias != provider.ID {
			continue
		}
		id := strings.TrimSpace(m.ID)
		if id != "" {
			modelIDs = append(modelIDs, id)
		}
	}
	for _, full := range modelAliases {
		id, ok := stripOnePrefix(full, alias, alias, provider.ID)
		if ok && id != "" {
			modelIDs = append(modelIDs, id)
		}
	}

	merged := uniqueStrings(modelIDs)
	for _, id := range merged {
		k, ok := staticKindByID[id]
		if !ok {
			k = inferKindFromUnknownModelId(id)
		}
		if _, allowed := kinds[k]; !allowed {
			continue
		}
		if isDisabled(disabled, alias, id) {
			continue
		}
		entries = append(entries, entry{ID: alias + "/" + id})
	}
	entries = append(entries, subKindEntries(provider, alias, kinds, disabled, true)...)
	return entries
}

// subKindEntries emits tts / embedding / webSearch / webFetch pseudo-models.
func subKindEntries(p providers.Provider, alias string, kinds map[Kind]struct{}, disabled map[string][]string, isFree bool) []entry {
	var entries []entry
	if ttsModels, ok := decodeModelList(p.TTSConfig, "models"); ok {
		if _, allowed := kinds[KindTTS]; allowed {
			for _, id := range ttsModels {
				if id == "" {
					continue
				}
				if isFree && isDisabled(disabled, alias, id) {
					continue
				}
				if !isFree && (isDisabled(disabled, alias, id) || isDisabled(disabled, p.Alias, id)) {
					continue
				}
				entries = append(entries, entry{ID: alias + "/" + id})
			}
		}
	}
	if embModels, ok := decodeModelList(p.EmbeddingConfig, "models"); ok {
		if _, allowed := kinds[KindEmbedding]; allowed {
			for _, id := range embModels {
				if id == "" {
					continue
				}
				if isFree && isDisabled(disabled, alias, id) {
					continue
				}
				if !isFree && (isDisabled(disabled, alias, id) || isDisabled(disabled, p.Alias, id)) {
					continue
				}
				entries = append(entries, entry{ID: alias + "/" + id})
			}
		}
	}
	if _, allowed := kinds[KindWebSearch]; allowed && len(p.SearchConfig) > 0 {
		entries = append(entries, entry{ID: alias + "/search", Kind: string(KindWebSearch)})
	}
	if _, allowed := kinds[KindWebFetch]; allowed && len(p.FetchConfig) > 0 {
		entries = append(entries, entry{ID: alias + "/fetch", Kind: string(KindWebFetch)})
	}
	return entries
}

// decodeModelList decodes a provider config blob and returns the list of ids
// under the given field (e.g. "models" for tts/embedding config).
func decodeModelList(raw json.RawMessage, field string) ([]string, bool) {
	if len(raw) == 0 {
		return nil, false
	}
	var generic map[string]any
	if err := json.Unmarshal(raw, &generic); err != nil {
		return nil, false
	}
	arr, ok := generic[field].([]any)
	if !ok {
		return nil, false
	}
	out := make([]string, 0, len(arr))
	for _, v := range arr {
		if m, ok := v.(map[string]any); ok {
			if id, _ := m["id"].(string); id != "" {
				out = append(out, id)
			}
		}
	}
	return out, true
}

func decodeRegistryModels(raw json.RawMessage) []registryModel {
	if len(raw) == 0 {
		return nil
	}
	var models []registryModel
	if err := json.Unmarshal(raw, &models); err != nil {
		return nil
	}
	return models
}

func stripPrefixes(ids []string, aliases ...string) []string {
	var out []string
	for _, id := range ids {
		stripped, ok := stripOnePrefix(id, aliases...)
		if ok {
			out = append(out, stripped)
		}
	}
	return out
}

func stripOnePrefix(id string, aliases ...string) (string, bool) {
	id = strings.TrimSpace(id)
	if id == "" {
		return "", false
	}
	for _, a := range aliases {
		prefix := a + "/"
		if strings.HasPrefix(id, prefix) {
			return strings.TrimPrefix(id, prefix), true
		}
	}
	return id, true
}

func uniqueStrings(in []string) []string {
	seen := make(map[string]struct{}, len(in))
	out := make([]string, 0, len(in))
	for _, s := range in {
		if s == "" {
			continue
		}
		if _, ok := seen[s]; ok {
			continue
		}
		seen[s] = struct{}{}
		out = append(out, s)
	}
	return out
}

func isDisabled(disabled map[string][]string, alias, modelID string) bool {
	if disabled == nil {
		return false
	}
	for _, m := range disabled[alias] {
		if m == modelID {
			return true
		}
	}
	return false
}
