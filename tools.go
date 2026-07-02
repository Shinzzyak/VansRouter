//go:build tools

package tools

import (
	_ "github.com/caarlos0/env/v11"
	_ "github.com/coreos/go-oidc/v3/oidc"
	_ "github.com/go-chi/chi/v5"
	_ "github.com/golang-jwt/jwt/v5"
	_ "github.com/google/uuid"
	_ "github.com/stretchr/testify"
	_ "golang.org/x/crypto/bcrypt"
	_ "golang.org/x/sync/singleflight"
	_ "modernc.org/sqlite"
)
