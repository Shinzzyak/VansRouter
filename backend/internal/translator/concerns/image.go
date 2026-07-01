package concerns

import (
	"encoding/base64"
	"fmt"
	"strings"

	"github.com/9router/9router/backend/internal/translator/schema"
)

// EncodeDataUri builds a data URI from a MIME type and base64 data.
func EncodeDataUri(mimeType, data string) string {
	if mimeType == "" {
		mimeType = schema.DefaultImageMIME
	}
	return fmt.Sprintf("data:%s;base64,%s", mimeType, data)
}

// ParsedDataURI holds the pieces of a data URI.
type ParsedDataURI struct {
	MimeType string
	Base64   string
}

// ParseDataUri parses a data URI into MIME type and base64 payload.
func ParseDataUri(uri string) *ParsedDataURI {
	const prefix = "data:"
	if !strings.HasPrefix(uri, prefix) {
		return nil
	}
	rest := uri[len(prefix):]
	idx := strings.Index(rest, ";base64,")
	if idx == -1 {
		return nil
	}
	mime := rest[:idx]
	data := rest[idx+len(";base64,"):]
	// Validate base64.
	if _, err := base64.StdEncoding.DecodeString(data); err != nil {
		return nil
	}
	return &ParsedDataURI{MimeType: mime, Base64: data}
}

// NormalizeImagePart returns the image part unchanged; deep normalization deferred.
func NormalizeImagePart(part map[string]any, mime string) map[string]any {
	if mime == "" {
		mime = schema.DefaultImageMIME
	}
	return part
}
