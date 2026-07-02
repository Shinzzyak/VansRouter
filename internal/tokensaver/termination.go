package tokensaver

import (
	"fmt"
	"strings"
)

// TerminationPrompt is the anti-loop stop-condition hint.
const TerminationPrompt = `When you have gathered sufficient information to answer the request, STOP calling tools and provide your final answer. Do not call a tool with the same arguments more than once. If a previous attempt returned the same result, change strategy or summarize with available data. Plan briefly (1-3 steps max), then ACT immediately. Do NOT restate your plan — if you have decided what to do, do it now. If you catch yourself repeating the same intention, STOP and give your answer with current knowledge.`

// ToolProtocolPrompt is the tool naming correctness prompt.
const ToolProtocolPrompt = `Tool protocol: call tools only through the structured tool_call mechanism. Use tool names exactly as listed; do not add prefixes, namespaces, dots, or concatenate words. Never invent tool names.`

// InjectTerminationPrompt appends the termination contract prompt to body.
func InjectTerminationPrompt(body map[string]any, format string) {
	InjectSystemPrompt(body, format, TerminationPrompt)
}

// InjectToolProtocolPrompt appends the tool protocol prompt, optionally with a
// list of valid tool names.
func InjectToolProtocolPrompt(body map[string]any, format string, toolNames []string) {
	prompt := ToolProtocolPrompt
	if len(toolNames) > 0 {
		unique := uniqueStrings(toolNames)
		if len(unique) > 80 {
			unique = unique[:80]
		}
		prompt = fmt.Sprintf("%s Valid tool names: %s.", ToolProtocolPrompt, strings.Join(unique, ", "))
	}
	InjectSystemPrompt(body, format, prompt)
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
