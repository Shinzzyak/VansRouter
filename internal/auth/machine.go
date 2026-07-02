package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
)

const (
	machineIDFile  = "machine-id"
	authDir        = "auth"
	cliSecretFile  = "cli-secret"
	CLIAuthSalt    = "9r-cli-auth"
	defaultSalt    = "endpoint-proxy-salt"
	cliTokenHeader = "x-9r-cli-token"
)

var (
	machineMu       sync.RWMutex
	cachedRawID     string
	cachedCliSecret string
	cachedCLIToken  string
)

// ResetMachineCache clears the in-memory machine-id and CLI-secret caches.
// It is exported for tests.
func ResetMachineCache() {
	machineMu.Lock()
	defer machineMu.Unlock()
	cachedRawID = ""
	cachedCliSecret = ""
	cachedCLIToken = ""
}

// GetConsistentMachineId returns a stable 16-character lowercase hex token for
// the given salt. When the salt matches CLIAuthSalt the on-disk CLI secret is
// mixed in, producing the internal trust token used by dashboard/CLI.
func GetConsistentMachineId(dataDir, salt string) (string, error) {
	if salt == "" {
		salt = defaultSalt
	}
	raw, err := loadRawMachineID(dataDir)
	if err != nil {
		return "", fmt.Errorf("load raw machine id: %w", err)
	}
	extra := ""
	if salt == CLIAuthSalt {
		sec, err := loadCliSecret(dataDir)
		if err != nil {
			return "", fmt.Errorf("load cli secret: %w", err)
		}
		extra = sec
	}
	h := sha256.Sum256([]byte(raw + salt + extra))
	return hex.EncodeToString(h[:])[:16], nil
}

func loadRawMachineID(dataDir string) (string, error) {
	machineMu.RLock()
	v := cachedRawID
	machineMu.RUnlock()
	if v != "" {
		return v, nil
	}

	machineMu.Lock()
	defer machineMu.Unlock()
	if cachedRawID != "" {
		return cachedRawID, nil
	}

	path := filepath.Join(dataDir, machineIDFile)
	b, err := os.ReadFile(path)
	if err == nil && len(b) > 0 {
		cachedRawID = strings.TrimSpace(string(b))
		return cachedRawID, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}

	id, err := readPlatformMachineID()
	if err != nil {
		id = randomHex(16)
	}
	cachedRawID = id
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return "", err
	}
	_ = os.WriteFile(path, []byte(cachedRawID), 0o600)
	return cachedRawID, nil
}

func loadCliSecret(dataDir string) (string, error) {
	machineMu.RLock()
	v := cachedCliSecret
	machineMu.RUnlock()
	if v != "" {
		return v, nil
	}

	machineMu.Lock()
	defer machineMu.Unlock()
	if cachedCliSecret != "" {
		return cachedCliSecret, nil
	}

	dir := filepath.Join(dataDir, authDir)
	path := filepath.Join(dir, cliSecretFile)
	b, err := os.ReadFile(path)
	if err == nil && len(b) > 0 {
		cachedCliSecret = strings.TrimSpace(string(b))
		return cachedCliSecret, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}

	cachedCliSecret = randomHex(32)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	if err := os.WriteFile(path, []byte(cachedCliSecret), 0o600); err != nil {
		return "", err
	}
	return cachedCliSecret, nil
}

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		// Last resort: deterministic filler. Should never happen in practice.
		for i := range b {
			b[i] = byte(i)
		}
	}
	return hex.EncodeToString(b)
}

func readPlatformMachineID() (string, error) {
	switch runtime.GOOS {
	case "linux":
		for _, p := range []string{"/etc/machine-id", "/var/lib/dbus/machine-id"} {
			b, err := os.ReadFile(p)
			if err == nil && len(b) > 0 {
				return strings.TrimSpace(string(b)), nil
			}
		}
	case "darwin":
		// ponytail: spawning ioreg adds complexity; random fallback is acceptable
		// for a local-only trust token because the secret file is the real root.
	case "windows":
		// ponytail: registry read is platform-specific and optional; random fallback ok.
	}
	return "", errors.New("no platform machine id")
}
