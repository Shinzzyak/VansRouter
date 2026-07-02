package executors

// MimoFreeExecutor is a thin wrapper around DefaultExecutor for the "mmf" provider.
type MimoFreeExecutor struct {
	DefaultExecutor
}

// NewMimoFreeExecutor creates a MimoFree executor.
func NewMimoFreeExecutor(provider string, cfg *ProviderConfig) *MimoFreeExecutor {
	return &MimoFreeExecutor{DefaultExecutor: *NewDefaultExecutor(provider, cfg)}
}

func init() {
	Register("mmf", func(provider string, cfg *ProviderConfig) Executor {
		return NewMimoFreeExecutor(provider, cfg)
	})
}
