package tokensaver

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"regexp"
	"sort"
	"strings"
)

const (
	singleRepeatThreshold  = 3
	sequenceRepeatThreshold = 2
	minSequenceLength      = 2
	textRepeatThreshold    = 3
	textSentenceThreshold  = 3
	minTextLength          = 12
)

// LoopResult reports whether a loop was detected and the hint to inject.
type LoopResult struct {
	Detected bool   `json:"detected"`
	Hint     string `json:"hint"`
}

// DetectLoop scans messages for repeated tool-call patterns or repeated
// assistant text. It mirrors open-sse/utils/loopGuard.js.
func DetectLoop(messages []map[string]any) LoopResult {
	seq := extractToolCallSequence(messages)
	if h := detectSingleRepeat(seq); h != "" {
		return LoopResult{Detected: true, Hint: "repeated tool call: " + h}
	}
	if h := detectSequenceRepeat(seq); h != "" {
		return LoopResult{Detected: true, Hint: "repeated tool sequence: " + h}
	}
	if h := detectTextLoop(messages); h != "" {
		return LoopResult{Detected: true, Hint: "repeated assistant text: " + h}
	}
	return LoopResult{Detected: false}
}

func extractToolCallSequence(messages []map[string]any) []string {
	var seq []string
	for _, msg := range messages {
		if msg == nil {
			continue
		}
		role, _ := msg["role"].(string)
		if role != "assistant" {
			continue
		}
		tcs, ok := msg["tool_calls"].([]any)
		if !ok {
			continue
		}
		for _, tc := range tcs {
			tcm, ok := tc.(map[string]any)
			if !ok {
				continue
			}
			seq = append(seq, toolCallHash(tcm))
		}
	}
	return seq
}

func toolCallHash(tc map[string]any) string {
	name := ""
	args := ""
	if fn, ok := tc["function"].(map[string]any); ok {
		if n, ok := fn["name"].(string); ok {
			name = n
		}
		if a, ok := fn["arguments"].(string); ok {
			args = normalizeArgs(a)
		} else if a, ok := fn["arguments"]; ok {
			b, _ := json.Marshal(a)
			args = normalizeArgs(string(b))
		}
	} else if n, ok := tc["name"].(string); ok {
		name = n
		if a, ok := tc["arguments"].(string); ok {
			args = normalizeArgs(a)
		} else if a, ok := tc["arguments"]; ok {
			b, _ := json.Marshal(a)
			args = normalizeArgs(string(b))
		}
	}
	return name + "::" + args
}

func normalizeArgs(argsStr string) string {
	var obj map[string]any
	if err := json.Unmarshal([]byte(argsStr), &obj); err != nil {
		return argsStr
	}
	b, _ := json.Marshal(obj)
	return string(b)
}

func detectSingleRepeat(seq []string) string {
	counts := make(map[string]int)
	for _, h := range seq {
		counts[h]++
		if counts[h] >= singleRepeatThreshold {
			return h
		}
	}
	return ""
}

func detectSequenceRepeat(seq []string) string {
	n := len(seq)
	for length := n / 2; length >= minSequenceLength; length-- {
		for start := 0; start <= n-length*2; start++ {
			pattern := joinHashes(seq[start : start+length])
			count := 0
			pos := 0
			for pos <= n-length {
				if joinHashes(seq[pos:pos+length]) == pattern {
					count++
					pos += length
				} else {
					pos++
				}
			}
			if count >= sequenceRepeatThreshold {
				return pattern
			}
		}
	}
	return ""
}

func joinHashes(hashes []string) string {
	return strings.Join(hashes, "|")
}

func detectTextLoop(messages []map[string]any) string {
	var texts []string
	for _, msg := range messages {
		if msg == nil {
			continue
		}
		role, _ := msg["role"].(string)
		if role != "assistant" {
			continue
		}
		text := messageText(msg)
		if len(text) >= minTextLength {
			texts = append(texts, text)
		}
	}
	counts := make(map[string]int)
	for _, text := range texts {
		norm := normalizeText(text)
		counts[norm]++
		if counts[norm] >= textRepeatThreshold {
			return norm
		}
	}
	sentenceCounts := make(map[string]int)
	for _, text := range texts {
		for _, s := range splitSentences(text) {
			norm := normalizeText(s)
			if len(norm) < minTextLength {
				continue
			}
			sentenceCounts[norm]++
			if sentenceCounts[norm] >= textSentenceThreshold {
				return norm
			}
		}
	}
	return ""
}

func messageText(msg map[string]any) string {
	switch content := msg["content"].(type) {
	case string:
		return content
	case []any:
		var parts []string
		for _, p := range content {
			part, ok := p.(map[string]any)
			if !ok {
				continue
			}
			if text, ok := part["text"].(string); ok {
				parts = append(parts, text)
			}
		}
		return strings.Join(parts, " ")
	}
	return ""
}

var whitespaceRE = regexp.MustCompile(`\s+`)
var trailingPunctRE = regexp.MustCompile(`[.!?…]+$`)

func normalizeText(text string) string {
	text = strings.ToLower(text)
	text = whitespaceRE.ReplaceAllString(text, " ")
	text = trailingPunctRE.ReplaceAllString(text, "")
	return strings.TrimSpace(text)
}

var sentenceRE = regexp.MustCompile(`[.!?…\n]+`)

func splitSentences(text string) []string {
	return sentenceRE.Split(text, -1)
}

// StableHash returns a deterministic short hash of v for loop identity.
func StableHash(v any) string {
	b, _ := json.Marshal(v)
	h := sha256.Sum224(b)
	return hex.EncodeToString(h[:8])
}

// SortKeys returns a copy of obj with sorted keys for stable comparison.
func SortKeys(obj map[string]any) map[string]any {
	keys := make([]string, 0, len(obj))
	for k := range obj {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make(map[string]any, len(obj))
	for _, k := range keys {
		out[k] = obj[k]
	}
	return out
}
