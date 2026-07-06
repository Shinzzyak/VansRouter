package models

// SourceSnapshot holds all DB-backed model metadata in one struct so the
// Builder can load it with a single Source call instead of five separate
// round trips.
type SourceSnapshot struct {
	Combos          []Combo
	Connections     []Connection
	CustomModels    []CustomModel
	ModelAliases    map[string]string
	DisabledByAlias map[string][]string
}
