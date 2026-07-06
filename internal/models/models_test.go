package models

import (
	"context"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/9router/9router/internal/providers"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type fakeSource struct {
	combos      []Combo
	connections []Connection
	custom      []CustomModel
	aliases     map[string]string
	disabled    map[string][]string
}

func (f *fakeSource) Snapshot(context.Context) (*SourceSnapshot, error) {
	return &SourceSnapshot{
		Combos:          f.combos,
		Connections:     f.connections,
		CustomModels:    f.custom,
		ModelAliases:    f.aliases,
		DisabledByAlias: f.disabled,
	}, nil
}

func loadTestRegistry(t *testing.T) *providers.Registry {
	t.Helper()
	reg, err := providers.LoadRegistry(filepath.Join("..", "..", "data", "providers.json"))
	require.NoError(t, err)
	return reg
}

func ids(ms []Model) []string {
	out := make([]string, len(ms))
	for i, m := range ms {
		out[i] = m.ID
	}
	sort.Strings(out)
	return out
}

func TestBuildModelsListCombos(t *testing.T) {
	reg := loadTestRegistry(t)
	src := &fakeSource{combos: []Combo{{ID: "c1", Name: "coding-stack", Kind: "llm"}}}
	b := NewBuilder(reg, src)

	out, err := b.BuildModelsList(context.Background(), []Kind{KindLLM})
	require.NoError(t, err)

	got := ids(out)
	assert.Contains(t, got, "combo/coding-stack")
	for _, m := range out {
		if strings.HasPrefix(m.ID, "combo/") {
			assert.Equal(t, "combo", m.OwnedBy)
		}
	}
}

func TestBuildModelsListComboKindFiltering(t *testing.T) {
	reg := loadTestRegistry(t)
	src := &fakeSource{
		combos: []Combo{
			{ID: "c1", Name: "search-combo", Kind: "webSearch"},
			{ID: "c2", Name: "chat-combo", Kind: "llm"},
		},
	}
	b := NewBuilder(reg, src)

	t.Run("only webSearch", func(t *testing.T) {
		out, err := b.BuildModelsList(context.Background(), []Kind{KindWebSearch})
		require.NoError(t, err)
		got := ids(out)
		assert.Contains(t, got, "combo/search-combo")
		assert.NotContains(t, got, "combo/chat-combo")
	})
	t.Run("only llm", func(t *testing.T) {
		out, err := b.BuildModelsList(context.Background(), []Kind{KindLLM})
		require.NoError(t, err)
		got := ids(out)
		assert.Contains(t, got, "combo/chat-combo")
		assert.NotContains(t, got, "combo/search-combo")
	})
}

func TestBuildModelsListRegistryProviders(t *testing.T) {
	reg := loadTestRegistry(t)
	src := &fakeSource{}
	b := NewBuilder(reg, src)

	out, err := b.BuildModelsList(context.Background(), []Kind{KindLLM})
	require.NoError(t, err)
	assert.NotEmpty(t, out)
}

func TestBuildModelsListDedup(t *testing.T) {
	reg := loadTestRegistry(t)
	src := &fakeSource{
		custom: []CustomModel{{ID: "gpt-4o", ProviderAlias: "oc"}},
	}
	b := NewBuilder(reg, src)

	out, err := b.BuildModelsList(context.Background(), []Kind{KindLLM})
	require.NoError(t, err)
	count := 0
	for _, m := range out {
		if m.ID == "oc/gpt-4o" {
			count++
		}
	}
	assert.LessOrEqual(t, count, 1)
}

func TestBuildModelsListDisabledFilter(t *testing.T) {
	reg := loadTestRegistry(t)
	src := &fakeSource{disabled: map[string][]string{"oc": {"gpt-4o"}}}
	b := NewBuilder(reg, src)

	out, err := b.BuildModelsList(context.Background(), []Kind{KindLLM})
	require.NoError(t, err)
	for _, m := range out {
		assert.NotEqual(t, "oc/gpt-4o", m.ID)
	}
}

func TestIsModelAllowedNoKey(t *testing.T) {
	reg := loadTestRegistry(t)
	b := NewBuilder(reg, &fakeSource{})
	ok, err := b.IsModelAllowed(context.Background(), "anything", false)
	require.NoError(t, err)
	assert.True(t, ok)
}

func TestIsModelAllowedKnown(t *testing.T) {
	reg := loadTestRegistry(t)
	src := &fakeSource{combos: []Combo{{ID: "c1", Name: "alpha", Kind: "llm"}}}
	b := NewBuilder(reg, src)

	ok, err := b.IsModelAllowed(context.Background(), "combo/alpha", true)
	require.NoError(t, err)
	assert.True(t, ok)

	ok, err = b.IsModelAllowed(context.Background(), "combo/missing", true)
	require.NoError(t, err)
	assert.False(t, ok)
}

func TestIsModelAllowedCaches(t *testing.T) {
	reg := loadTestRegistry(t)
	src := &fakeSource{combos: []Combo{{ID: "c1", Name: "alpha", Kind: "llm"}}}

	loadCount := 0
	counting := &countingSource{
		Source: src,
		onSnapshot: func() { loadCount++ },
	}
	b := NewBuilder(reg, counting)

	_, err := b.IsModelAllowed(context.Background(), "combo/alpha", true)
	require.NoError(t, err)
	_, err = b.IsModelAllowed(context.Background(), "combo/alpha", true)
	require.NoError(t, err)
	_, err = b.IsModelAllowed(context.Background(), "combo/alpha", true)
	require.NoError(t, err)
	assert.Equal(t, 1, loadCount, "allow-list should be cached across calls")
}

func TestBuilderInvalidateCache(t *testing.T) {
	reg := loadTestRegistry(t)
	src := &fakeSource{combos: []Combo{{ID: "c1", Name: "alpha", Kind: "llm"}}}

	loadCount := 0
	counting := &countingSource{
		Source: src,
		onSnapshot: func() { loadCount++ },
	}
	b := NewBuilder(reg, counting)

	_, err := b.IsModelAllowed(context.Background(), "combo/alpha", true)
	require.NoError(t, err)
	b.InvalidateCache()
	_, err = b.IsModelAllowed(context.Background(), "combo/alpha", true)
	require.NoError(t, err)
	assert.Equal(t, 2, loadCount)
}

type countingSource struct {
	Source
	onSnapshot func()
}

func (c *countingSource) Snapshot(ctx context.Context) (*SourceSnapshot, error) {
	if c.onSnapshot != nil {
		c.onSnapshot()
	}
	return c.Source.Snapshot(ctx)
}

func TestInferKindFromUnknownModelId(t *testing.T) {
	cases := map[string]Kind{
		"text-embedding-3-small": KindEmbedding,
		"elevenlabs-tts-v1":      KindTTS,
		"dall-e-3":               KindImage,
		"imagen-3":               KindImage,
		"sd-xl":                  KindImage,
		"gpt-4o":                 KindLLM,
		"claude-opus-4":          KindLLM,
	}
	for in, want := range cases {
		assert.Equal(t, want, inferKindFromUnknownModelId(in), in)
	}
}

func TestStripOnePrefix(t *testing.T) {
	id, ok := stripOnePrefix("oc/gpt-4o", "oc", "openai")
	assert.True(t, ok)
	assert.Equal(t, "gpt-4o", id)

	id, ok = stripOnePrefix("gpt-4o", "oc", "openai")
	assert.True(t, ok)
	assert.Equal(t, "gpt-4o", id)

	id, ok = stripOnePrefix("", "oc")
	assert.False(t, ok)
}

func TestUniqueStrings(t *testing.T) {
	got := uniqueStrings([]string{"a", "b", "a", "", "c", "b"})
	assert.Equal(t, []string{"a", "b", "c"}, got)
}
