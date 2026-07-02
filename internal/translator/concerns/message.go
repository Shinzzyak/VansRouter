package concerns

import (
	"strings"

	"github.com/9router/9router/internal/translator/schema"
)

// CollapseTextParts turns a slice of OpenAI text parts into a single content value.
func CollapseTextParts(parts []map[string]any) any {
	if len(parts) == 0 {
		return ""
	}
	if len(parts) == 1 {
		return parts[0]
	}
	var texts []string
	for _, p := range parts {
		if p["type"] == schema.OpenAIBlockTypeText {
			if t, ok := p["text"].(string); ok {
				texts = append(texts, t)
			}
		}
	}
	if len(texts) > 0 {
		return map[string]any{
			"type": schema.OpenAIBlockTypeText,
			"text": joinStrings(texts, "\n"),
		}
	}
	return parts
}

// ExtractTextContent extracts plain text from a string or content array.
func ExtractTextContent(content any, sep string) string {
	if sep == "" {
		sep = "\n"
	}
	switch v := content.(type) {
	case string:
		return v
	case []any:
		var texts []string
		for _, item := range v {
			if m, ok := item.(map[string]any); ok {
				if m["type"] == schema.OpenAIBlockTypeText {
					if t, ok := m["text"].(string); ok {
						texts = append(texts, t)
					}
				}
			}
		}
		return joinStrings(texts, sep)
	case []map[string]any:
		var texts []string
		for _, m := range v {
			if m["type"] == schema.OpenAIBlockTypeText {
				if t, ok := m["text"].(string); ok {
					texts = append(texts, t)
				}
			}
		}
		return joinStrings(texts, sep)
	}
	return ""
}

// NormalizeMessage returns the message unchanged; deep normalization deferred.
func NormalizeMessage(msg map[string]any) map[string]any {
	return msg
}

// DeepCloneMessage makes a shallow clone of a message map.
func DeepCloneMessage(msg map[string]any) map[string]any {
	out := make(map[string]any, len(msg))
	for k, v := range msg {
		out[k] = v
	}
	return out
}

func joinStrings(parts []string, sep string) string {
	return strings.Join(parts, sep)
}
