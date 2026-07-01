package auth

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestGetConsistentMachineId(t *testing.T) {
	dir := t.TempDir()
	ResetMachineCache()

	t.Run("stable for same salt", func(t *testing.T) {
		a, err := GetConsistentMachineId(dir, "test-salt")
		require.NoError(t, err)
		b, err := GetConsistentMachineId(dir, "test-salt")
		require.NoError(t, err)
		assert.Equal(t, a, b)
		assert.Len(t, a, 16)
		assert.Regexp(t, expectedTokenRe, a)
	})
	t.Run("cli salt differs from default salt", func(t *testing.T) {
		a, err := GetConsistentMachineId(dir, "")
		require.NoError(t, err)
		b, err := GetConsistentMachineId(dir, CLIAuthSalt)
		require.NoError(t, err)
		assert.NotEqual(t, a, b)
	})
	t.Run("cli secret file is created", func(t *testing.T) {
		_, err := GetConsistentMachineId(dir, CLIAuthSalt)
		require.NoError(t, err)
		_, err = os.Stat(filepath.Join(dir, authDir, cliSecretFile))
		assert.NoError(t, err)
	})
	t.Run("machine id file is created", func(t *testing.T) {
		_, err := GetConsistentMachineId(dir, "salt")
		require.NoError(t, err)
		_, err = os.Stat(filepath.Join(dir, machineIDFile))
		assert.NoError(t, err)
	})
}
