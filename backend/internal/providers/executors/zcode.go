package executors

// ZcodeExecutor is a thin wrapper around DefaultExecutor for the "zc" provider.
type ZcodeExecutor struct {
	DefaultExecutor
}

// NewZcodeExecutor creates a Zcode executor.
func NewZcodeExecutor(provider string, cfg *ProviderConfig) *ZcodeExecutor {
	return &ZcodeExecutor{DefaultExecutor: *NewDefaultExecutor(provider, cfg)}
}

func init() {
	Register("zc", func(provider string, cfg *ProviderConfig) Executor {
		return NewZcodeExecutor(provider, cfg)
	})
}
