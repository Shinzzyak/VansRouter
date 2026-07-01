package concerns

import (
	"encoding/json"
	"fmt"
)

// ponytail: JSON schema coercion and strict mode handling deferred.
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

func SafeUnmarshal(data []byte, out any) error {
	return json.Unmarshal(data, out)
}
