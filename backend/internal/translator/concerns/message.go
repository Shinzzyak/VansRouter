package concerns

// ponytail: message normalisation and role conversion deferred.
func NormalizeMessage(msg map[string]any) map[string]any {
	return msg
}

func DeepCloneMessage(msg map[string]any) map[string]any {
	out := make(map[string]any, len(msg))
	for k, v := range msg {
		out[k] = v
	}
	return out
}
