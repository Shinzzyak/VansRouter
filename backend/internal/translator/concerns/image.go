package concerns

import "github.com/9router/9router/backend/internal/translator/schema"

// ponytail: image URL/base64 conversion and validation deferred.
func NormalizeImagePart(part map[string]any, mime string) map[string]any {
	if mime == "" {
		mime = schema.DefaultImageMIME
	}
	return part
}
