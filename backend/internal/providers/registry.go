package providers

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
)

// Registry is the top-level structure exported by scripts/export-registry.js.
type Registry struct {
	GeneratedAt     string                     `json:"generatedAt"`
	NodeVersion     string                     `json:"nodeVersion"`
	Providers       map[string]Provider        `json:"providers"`
	PROVIDERS       map[string]json.RawMessage `json:"PROVIDERS"`
	PROVIDER_MODELS map[string]json.RawMessage `json:"PROVIDER_MODELS"`
	PROVIDER_OAUTH  map[string]json.RawMessage `json:"PROVIDER_OAUTH"`
	PROVIDER_MEDIA  map[string]json.RawMessage `json:"PROVIDER_MEDIA"`
}

// Provider mirrors a single provider entry from the registry.
// Nested structures that are not needed for validation are kept as json.RawMessage
// so the loader stays future-proof without over-modelling.
// ponytail: only scalar/filter fields are typed; decode RawMessage on demand later.
// ponytail: providerOverrides table is speculative; only openai/anthropic/gemini/groq tuning is likely needed at launch.
type Provider struct {
	ID                      string          `json:"id"`
	Alias                   string          `json:"alias"`
	UIAlias                 string          `json:"uiAlias"`
	Category                string          `json:"category"`
	AuthType                string          `json:"authType"`
	HasOAuth                bool            `json:"hasOAuth"`
	NoAuth                  bool            `json:"noAuth"`
	Hidden                  bool            `json:"hidden"`
	HasFree                 bool            `json:"hasFree"`
	HasProviderSpecificData bool            `json:"hasProviderSpecificData"`
	AuthModes               []string        `json:"authModes"`
	ServiceKinds            []string        `json:"serviceKinds"`
	Priority                int             `json:"priority"`
	Display                 json.RawMessage `json:"display"`
	Transport               json.RawMessage `json:"transport"`
	Transports              json.RawMessage `json:"transports"`
	Models                  json.RawMessage `json:"models"`
	PassthroughModels       json.RawMessage `json:"passthroughModels"`
	OAuth                   json.RawMessage `json:"oauth"`
	Aliases                 json.RawMessage `json:"aliases"`
	AuthHint                json.RawMessage `json:"authHint"`
	EmbeddingConfig         json.RawMessage `json:"embeddingConfig"`
	ImageConfig             json.RawMessage `json:"imageConfig"`
	STTConfig               json.RawMessage `json:"sttConfig"`
	TTSConfig               json.RawMessage `json:"ttsConfig"`
	SearchConfig            json.RawMessage `json:"searchConfig"`
	FetchConfig             json.RawMessage `json:"fetchConfig"`
	ThinkingConfig          json.RawMessage `json:"thinkingConfig"`
	MediaPriority           json.RawMessage `json:"mediaPriority"`
	DefaultRegion           json.RawMessage `json:"defaultRegion"`
	FreeNote                json.RawMessage `json:"freeNote"`
	HiddenKinds             json.RawMessage `json:"hiddenKinds"`
	SearchViaChat           json.RawMessage `json:"searchViaChat"`
	ModelsFetcher           json.RawMessage `json:"modelsFetcher"`
	Features                json.RawMessage `json:"features"`
}

// LoadRegistry reads and validates the provider registry JSON at path.
func LoadRegistry(path string) (*Registry, error) {
	if path == "" {
		return nil, errors.New("registry path is required")
	}

	b, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read registry: %w", err)
	}

	var r Registry
	if err := json.Unmarshal(b, &r); err != nil {
		return nil, fmt.Errorf("parse registry: %w", err)
	}

	if err := validateRegistry(&r); err != nil {
		return nil, fmt.Errorf("validate registry: %w", err)
	}

	return &r, nil
}

func validateRegistry(r *Registry) error {
	if r.GeneratedAt == "" {
		return errors.New("missing generatedAt")
	}
	if r.NodeVersion == "" {
		return errors.New("missing nodeVersion")
	}
	if len(r.Providers) == 0 {
		return errors.New("providers map is empty")
	}
	if len(r.PROVIDERS) == 0 {
		return errors.New("PROVIDERS map is empty")
	}
	if len(r.PROVIDER_MODELS) == 0 {
		return errors.New("PROVIDER_MODELS map is empty")
	}
	if len(r.PROVIDER_OAUTH) == 0 {
		return errors.New("PROVIDER_OAUTH map is empty")
	}
	if len(r.PROVIDER_MEDIA) == 0 {
		return errors.New("PROVIDER_MEDIA map is empty")
	}
	return nil
}
