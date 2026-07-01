package formats

// ponytail: model-specific max-token defaults and cap enforcement deferred.
func MaxTokensForModel(model string, requested *int) *int {
	return requested
}
