package executors

// CursorExecutor is a thin wrapper around DefaultExecutor for the "cu" provider.
type CursorExecutor struct {
	DefaultExecutor
}

// NewCursorExecutor creates a Cursor executor.
func NewCursorExecutor(provider string, cfg *ProviderConfig) *CursorExecutor {
	return &CursorExecutor{DefaultExecutor: *NewDefaultExecutor(provider, cfg)}
}

func init() {
	Register("cu", func(provider string, cfg *ProviderConfig) Executor {
		return NewCursorExecutor(provider, cfg)
	})
}
