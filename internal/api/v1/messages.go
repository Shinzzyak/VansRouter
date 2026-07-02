package v1

import (
	"encoding/json"
	"io"
	"math"
	"net/http"
)

// MessagesHandler handles POST /v1/messages/count_tokens.
type MessagesHandler struct{}

func (h *MessagesHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "POST required")
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request_error", "failed to read body")
		return
	}
	defer r.Body.Close()

	var payload struct {
		Messages []Message `json:"messages"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request_error", "invalid JSON")
		return
	}

	totalChars := 0
	for _, msg := range payload.Messages {
		totalChars += countMessageChars(msg)
	}
	inputTokens := int(math.Ceil(float64(totalChars) / 4.0))

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]any{
		"input_tokens": inputTokens,
	})
}

type Message struct {
	Role    string      `json:"role"`
	Content interface{} `json:"content"`
}

type TextContent struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

func countMessageChars(msg Message) int {
	switch v := msg.Content.(type) {
	case string:
		return len(v)
	case []interface{}:
		sum := 0
		for _, raw := range v {
			switch part := raw.(type) {
			case map[string]interface{}:
				if t, ok := part["type"].(string); ok && t == "text" {
					if txt, ok := part["text"].(string); ok {
						sum += len(txt)
					}
				}
			case TextContent:
				if part.Type == "text" {
					sum += len(part.Text)
				}
			}
		}
		return sum
	}
	return 0
}
