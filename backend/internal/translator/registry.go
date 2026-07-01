package translator

import "sync"

type RequestTranslator func(model string, body map[string]any, stream bool, creds any) (map[string]any, error)

type ResponseTranslator func(chunk map[string]any, state *State) ([]map[string]any, error)

var (
	reqMu            sync.RWMutex
	resMu            sync.RWMutex
	requestRegistry  = map[string]RequestTranslator{}
	responseRegistry = map[string]ResponseTranslator{}
)

func Register(from, to string, req RequestTranslator, res ResponseTranslator) {
	key := from + ":" + to
	if req != nil {
		reqMu.Lock()
		defer reqMu.Unlock()
		requestRegistry[key] = req
	}
	if res != nil {
		resMu.Lock()
		defer resMu.Unlock()
		responseRegistry[key] = res
	}
}

func GetRequestTranslator(key string) RequestTranslator {
	reqMu.RLock()
	defer reqMu.RUnlock()
	return requestRegistry[key]
}

func GetResponseTranslator(key string) ResponseTranslator {
	resMu.RLock()
	defer resMu.RUnlock()
	return responseRegistry[key]
}
