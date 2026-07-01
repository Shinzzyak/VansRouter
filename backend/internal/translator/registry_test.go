package translator

import "testing"

func TestRegistry(t *testing.T) {
	Register("test-from", "test-to",
		func(model string, body map[string]any, stream bool, creds any) (map[string]any, error) { return body, nil },
		nil,
	)
	if GetRequestTranslator("test-from:test-to") == nil {
		t.Fatal("expected request translator")
	}
	Register("test-to", "test-from", nil,
		func(chunk map[string]any, state *State) ([]map[string]any, error) { return []map[string]any{chunk}, nil },
	)
	if GetResponseTranslator("test-to:test-from") == nil {
		t.Fatal("expected response translator")
	}
	if GetRequestTranslator("missing:key") != nil {
		t.Fatal("expected nil for missing translator")
	}
}
