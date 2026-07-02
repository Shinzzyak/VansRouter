package executors

import "sync"

var (
	registryMu sync.RWMutex
	registry   = map[string]func(string, *ProviderConfig) Executor{}
)

// Register records a factory for provider id name. Factories are invoked by
// Get to create the Executor that should handle a request.
func Register(name string, factory func(provider string, cfg *ProviderConfig) Executor) {
	registryMu.Lock()
	defer registryMu.Unlock()
	registry[name] = factory
}

// Get returns the registered Executor for provider, falling back to built-in
// defaults when no factory is registered.
func Get(provider string, cfg *ProviderConfig) Executor {
	registryMu.RLock()
	defer registryMu.RUnlock()
	if factory, ok := registry[provider]; ok {
		return factory(provider, cfg)
	}
	switch provider {
	case "cu":
		return NewCursorExecutor(provider, cfg)
	case "mmf":
		return NewMimoFreeExecutor(provider, cfg)
	case "zc":
		return NewZcodeExecutor(provider, cfg)
	}
	return NewDefaultExecutor(provider, cfg)
}
