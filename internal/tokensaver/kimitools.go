package tokensaver

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

const (
	kimiToolPrefix = "functions."
	maxKimiCalls   = 64
)

var kimiHeaderRE = regexp.MustCompile(`^([a-zA-Z0-9_\-/.]+)(?::([a-zA-Z0-9_\-]+))?$`)

// HasKimiToolMarkup reports whether content contains native Kimi tool-call markup.
func HasKimiToolMarkup(content string) bool {
	return strings.Contains(content, kimiToolPrefix)
}

// SplitKimiToolRegion splits content into leading prose and the tool-call tail.
func SplitKimiToolRegion(content string) (prefix string, tail string) {
	idx := strings.Index(content, kimiToolPrefix)
	if idx == -1 {
		return content, ""
	}
	return strings.TrimSpace(content[:idx]), content[idx:]
}

// KimiToolCall matches the OpenAI tool_calls item shape.
type KimiToolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

// ExtractKimiToolCalls parses all native Kimi tool calls from content.
func ExtractKimiToolCalls(content string) []KimiToolCall {
	if !HasKimiToolMarkup(content) {
		return nil
	}
	_, tail := SplitKimiToolRegion(content)
	if tail == "" {
		return nil
	}
	var calls []KimiToolCall
	remaining := tail
	index := 0
	for len(remaining) > 0 && len(calls) < maxKimiCalls {
		if !strings.HasPrefix(remaining, kimiToolPrefix) {
			break
		}
		remaining = remaining[len(kimiToolPrefix):]
		nextPrefix := strings.Index(remaining, kimiToolPrefix)
		fragment := remaining
		if nextPrefix != -1 {
			fragment = remaining[:nextPrefix]
		}
		call, ok := parseKimiToolCallFragment(fragment, index)
		if !ok {
			break
		}
		calls = append(calls, call)
		index++
		if nextPrefix == -1 {
			break
		}
		remaining = remaining[nextPrefix:]
	}
	return calls
}

func parseKimiToolCallFragment(fragment string, index int) (KimiToolCall, bool) {
	var call KimiToolCall
	if fragment == "" {
		return call, false
	}
	jsonStart := strings.Index(fragment, "{")
	if jsonStart == -1 {
		return call, false
	}
	header := strings.TrimSpace(fragment[:jsonStart])
	argsRaw := fragment[jsonStart:]
	m := kimiHeaderRE.FindStringSubmatch(header)
	if m == nil {
		return call, false
	}
	name := m[1]
	providedID := m[2]
	args, err := parseKimiJSONObject(argsRaw)
	if err != nil {
		return call, false
	}
	argsJSON, err := json.Marshal(args)
	if err != nil {
		return call, false
	}
	id := providedID
	if id == "" {
		id = fmt.Sprintf("%d", index)
	}
	call.ID = fmt.Sprintf("functions.%s:%s", name, id)
	call.Type = "function"
	call.Function.Name = name
	call.Function.Arguments = string(argsJSON)
	return call, true
}

func parseKimiJSONObject(text string) (map[string]any, error) {
	depth := 0
	inString := false
	escape := false
	end := -1
	for i := 0; i < len(text); i++ {
		ch := text[i]
		if inString {
			if escape {
				escape = false
				continue
			}
			if ch == '\\' {
				escape = true
				continue
			}
			if ch == '"' {
				inString = false
			}
			continue
		}
		if ch == '"' {
			inString = true
			continue
		}
		if ch == '{' {
			depth++
			if depth == 1 {
				end = -1
			}
			continue
		}
		if ch == '}' {
			depth--
			if depth == 0 {
				end = i + 1
				break
			}
			continue
		}
	}
	if end == -1 {
		return nil, fmt.Errorf("unbalanced JSON object")
	}
	var obj map[string]any
	if err := json.Unmarshal([]byte(text[:end]), &obj); err != nil {
		return nil, err
	}
	return obj, nil
}

// NormalizeKimiToolCalls detects native Kimi markup in a message and converts
// it to structured tool_calls. It returns the normalized message and whether
// tools were found.
func NormalizeKimiToolCalls(message map[string]any) (map[string]any, bool) {
	if message == nil {
		return nil, false
	}
	if tcs, ok := message["tool_calls"].([]any); ok && len(tcs) > 0 {
		return message, true
	}
	content, _ := message["content"].(string)
	calls := ExtractKimiToolCalls(content)
	if len(calls) == 0 {
		return message, false
	}
	prefix, _ := SplitKimiToolRegion(content)
	out := make(map[string]any, len(message)+2)
	for k, v := range message {
		out[k] = v
	}
	out["content"] = prefix
	toolCalls := make([]any, len(calls))
	for i, c := range calls {
		toolCalls[i] = map[string]any{
			"id":   c.ID,
			"type": c.Type,
			"function": map[string]any{
				"name":      c.Function.Name,
				"arguments": c.Function.Arguments,
			},
		}
	}
	out["tool_calls"] = toolCalls
	return out, true
}
