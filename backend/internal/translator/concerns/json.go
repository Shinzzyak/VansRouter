package concerns

import (
	"encoding/json"
	"fmt"
)

// ParseJSONSchema coerces raw input into a JSON schema map.
func ParseJSONSchema(raw any) (map[string]any, error) {
	switch v := raw.(type) {
	case map[string]any:
		return v, nil
	case string:
		var out map[string]any
		if err := json.Unmarshal([]byte(v), &out); err != nil {
			return nil, fmt.Errorf("invalid json schema: %w", err)
		}
		return out, nil
	default:
		return nil, fmt.Errorf("unsupported json schema type: %T", raw)
	}
}

// SafeUnmarshal unmarshals JSON into out.
func SafeUnmarshal(data []byte, out any) error {
	return json.Unmarshal(data, out)
}

// SafeParseJSON tries to parse s as JSON; on failure returns s itself as a string.
func SafeParseJSON(s string, fallback string) any {
	var out any
	if err := json.Unmarshal([]byte(s), &out); err == nil {
		return out
	}
	return fallback
}

// MarshalJSON marshals v to a JSON string.
func MarshalJSON(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}
