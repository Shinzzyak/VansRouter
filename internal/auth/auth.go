// Package auth implements API-key validation, provider/combo/kind ACL checks,
// and the internal-trust gate used by dashboard/CLI requests.
//
// ACL semantics follow the JavaScript backend contract:
//   - nil allow-list  = all allowed
//   - empty allow-list = none allowed
//   - non-empty allow-list = only listed values allowed
package auth
