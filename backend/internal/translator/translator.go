package translator

import "fmt"

type State struct {
	MessageID            string
	Model                string
	TextBlockStarted     bool
	ThinkingBlockStarted bool
	InThinkingBlock      bool
	CurrentBlockIndex    *int
	ToolCalls            map[string]any
	FinishReason         string
	FinishReasonSent     bool
	Usage                map[string]any
	ContentBlockIndex    int
}

func TranslateRequest(source, target Format, model string, body map[string]any, stream bool, creds any) (map[string]any, error) {
	key := string(source) + ":" + string(target)
	translator := GetRequestTranslator(key)
	if translator == nil {
		return nil, fmt.Errorf("no request translator registered for %s", key)
	}
	return translator(model, body, stream, creds)
}

func TranslateResponse(target, source Format, chunk map[string]any, state *State) ([]map[string]any, error) {
	key := string(target) + ":" + string(source)
	translator := GetResponseTranslator(key)
	if translator == nil {
		return nil, fmt.Errorf("no response translator registered for %s", key)
	}
	return translator(chunk, state)
}

func NeedsTranslation(source, target Format) bool {
	return source != target
}

func InitState(source Format) *State {
	return &State{}
}
