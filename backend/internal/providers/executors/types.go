package executors

import (
	"encoding/json"
	"strconv"
)

// defaultRetryDelayMs mirrors RETRY_CONFIG.delayMs in open-sse/config/runtimeConfig.js.
const defaultRetryDelayMs = 2000

// Credentials holds the authentication material for a single provider request.
type Credentials struct {
	APIKey               string
	AccessToken          string
	RefreshToken         string
	ProviderSpecificData map[string]any
	RuntimeTransport     *RuntimeTransport
}

// RuntimeTransport allows a caller to override the provider's configured
// endpoint, path suffix, extra headers, and auth descriptor at runtime.
type RuntimeTransport struct {
	BaseURL   string            `json:"baseUrl"`
	URLSuffix string            `json:"urlSuffix"`
	Headers   map[string]string `json:"headers"`
	Auth      json.RawMessage   `json:"auth"`
}

// ExecuteRequest is the input to BaseExecutor.Execute.
type ExecuteRequest struct {
	Model        string
	Body         map[string]any
	Stream       bool
	Credentials  Credentials
	AccountCount int
}

// RetryEntry describes how many times and how long to wait before retrying a
// single URL for a given status code.
type RetryEntry struct {
	Attempts int `json:"attempts"`
	DelayMs  int `json:"delayMs"`
}

// RetryConfig maps HTTP status codes to retry policy.
type RetryConfig map[int]RetryEntry

// UnmarshalJSON accepts either an object with string status-code keys or a
// number shorthand (treated as attempts with the default delay).
func (rc *RetryConfig) UnmarshalJSON(b []byte) error {
	if len(b) == 0 {
		*rc = nil
		return nil
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	cfg := make(RetryConfig, len(raw))
	for k, v := range raw {
		code, err := strconv.Atoi(k)
		if err != nil {
			return err
		}
		var entry RetryEntry
		if err := entry.UnmarshalJSON(v); err != nil {
			return err
		}
		cfg[code] = entry
	}
	*rc = cfg
	return nil
}

// UnmarshalJSON accepts either a {attempts, delayMs} object or a plain integer
// number of attempts (delay falls back to defaultRetryDelayMs).
func (re *RetryEntry) UnmarshalJSON(b []byte) error {
	if len(b) == 0 {
		return nil
	}
	if b[0] == '{' {
		var raw struct {
			Attempts int `json:"attempts"`
			DelayMs  int `json:"delayMs"`
		}
		if err := json.Unmarshal(b, &raw); err != nil {
			return err
		}
		*re = RetryEntry{Attempts: raw.Attempts, DelayMs: raw.DelayMs}
		return nil
	}
	var n int
	if err := json.Unmarshal(b, &n); err != nil {
		return err
	}
	*re = RetryEntry{Attempts: n, DelayMs: defaultRetryDelayMs}
	return nil
}

// ProviderConfig is the subset of the provider registry transport object needed
// by the executor in this step. Nested fields are decoded on demand.
type ProviderConfig struct {
	BaseUrl        string            `json:"baseUrl"`
	BaseUrls       []string          `json:"baseUrls"`
	Headers        map[string]string `json:"headers"`
	TimeoutMs      int               `json:"timeoutMs"`
	Retry          RetryConfig       `json:"retry"`
	URLSuffix      string            `json:"urlSuffix"`
	Format         string            `json:"format"`
	NoAuth         bool              `json:"noAuth"`
	PreserveAccept bool              `json:"preserveAccept"`
	Auth           json.RawMessage   `json:"auth"`
}

// AuthSpec describes a single header/scheme pair for a credential branch.
type AuthSpec struct {
	Header string   `json:"header"`
	Scheme string   `json:"scheme"`
	Hooks  []string `json:"hooks"`
}

// AuthDescriptor is the registry transport.auth object. Combined descriptors set
// one header from the first available token; split descriptors route apiKey vs
// OAuth to different headers.
type AuthDescriptor struct {
	Combined         bool      `json:"combined"`
	Header           string    `json:"header"`
	Scheme           string    `json:"scheme"`
	APIKey           *AuthSpec `json:"apiKey,omitempty"`
	OAuth            *AuthSpec `json:"oauth,omitempty"`
	AnthropicVersion bool      `json:"anthropicVersion"`
	Hooks            []string  `json:"hooks"`
}
