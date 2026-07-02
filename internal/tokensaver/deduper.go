package tokensaver

import (
	"regexp"
)

type dedupRule struct {
	triggers []*regexp.Regexp
	strip    []*regexp.Regexp
}

var dedupRules = []dedupRule{
	{
		triggers: []*regexp.Regexp{
			regexp.MustCompile(`^mcp__exa__web_search_exa$`),
			regexp.MustCompile(`^mcp__exa__web_fetch_exa$`),
		},
		strip: []*regexp.Regexp{
			regexp.MustCompile(`^WebSearch$`),
			regexp.MustCompile(`^WebFetch$`),
			regexp.MustCompile(`^mcp__workspace__web_fetch$`),
		},
	},
	{
		triggers: []*regexp.Regexp{
			regexp.MustCompile(`^mcp__tavily__tavily_search$`),
			regexp.MustCompile(`^mcp__tavily__tavily_extract$`),
		},
		strip: []*regexp.Regexp{
			regexp.MustCompile(`^WebSearch$`),
			regexp.MustCompile(`^WebFetch$`),
			regexp.MustCompile(`^mcp__workspace__web_fetch$`),
		},
	},
	{
		triggers: []*regexp.Regexp{
			regexp.MustCompile(`^mcp__browsermcp__`),
		},
		strip: []*regexp.Regexp{
			regexp.MustCompile(`^mcp__Claude_in_Chrome__`),
		},
	},
}

// DedupeTools strips built-in tools when an equivalent MCP tool is present.
// It returns the filtered tools and a list of stripped names.
func DedupeTools(tools []map[string]any) ([]map[string]any, []string) {
	if len(tools) == 0 {
		return tools, nil
	}
	names := make([]string, len(tools))
	for i, t := range tools {
		names[i] = toolName(t)
	}
	toStrip := make(map[string]struct{})
	for _, rule := range dedupRules {
		hasTrigger := false
		for _, n := range names {
			if matchesAny(n, rule.triggers) {
				hasTrigger = true
				break
			}
		}
		if !hasTrigger {
			continue
		}
		for _, n := range names {
			if matchesAny(n, rule.strip) {
				toStrip[n] = struct{}{}
			}
		}
	}
	if len(toStrip) == 0 {
		return tools, nil
	}
	out := make([]map[string]any, 0, len(tools))
	for _, t := range tools {
		if _, ok := toStrip[toolName(t)]; !ok {
			out = append(out, t)
		}
	}
	stripped := make([]string, 0, len(toStrip))
	for n := range toStrip {
		stripped = append(stripped, n)
	}
	return out, stripped
}

func toolName(t map[string]any) string {
	if t == nil {
		return ""
	}
	if n, ok := t["name"].(string); ok {
		return n
	}
	if fn, ok := t["function"].(map[string]any); ok {
		if n, ok := fn["name"].(string); ok {
			return n
		}
	}
	return ""
}

func matchesAny(s string, patterns []*regexp.Regexp) bool {
	for _, p := range patterns {
		if p.MatchString(s) {
			return true
		}
	}
	return false
}
