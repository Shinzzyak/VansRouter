package translator

import "testing"

func TestRegistry(t *testing.T) {
	Register("claude", "openai",
		func(model string, body map[string]any, stream bool, creds any) (map[string]any, error) { return body, nil },
		nil,
	)
	if GetRequestTranslator("claude:openai") == nil {
		t.Fatal("expected request translator")
	}
	Register("openai", "claude", nil,
		func(chunk map[string]any, state *State) ([]map[string]any, error) { return []map[string]any{chunk}, nil },
	)
	if GetResponseTranslator("openai:claude") == nil {
		t.Fatal("expected response translator")
	}
	if GetRequestTranslator("missing:key") != nil {
		t.Fatal("expected nil for missing translator")
	}
}
