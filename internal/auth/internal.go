package auth

import (
	"crypto/subtle"
	"net/http"
	"regexp"
)

var expectedTokenRe = regexp.MustCompile(`^[0-9a-f]{16}$`)

// DataDirSource supplies the data directory used for token derivation.
// The server sets this at startup; tests can override it.
var DataDirSource func() string

// IsTrustedInternalRequest returns true only when the request carries the
// valid internal CLI token. It fails closed: any error, missing header, shape
// mismatch, or length mismatch returns false.
func IsTrustedInternalRequest(r *http.Request) bool {
	if r == nil {
		return false
	}
	token := r.Header.Get(cliTokenHeader)
	if token == "" {
		return false
	}
	dataDir := ""
	if DataDirSource != nil {
		dataDir = DataDirSource()
	}
	expected, err := GetConsistentMachineId(dataDir, CLIAuthSalt)
	if err != nil || !expectedTokenRe.MatchString(expected) {
		return false
	}
	if len(token) != len(expected) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(token), []byte(expected)) == 1
}
