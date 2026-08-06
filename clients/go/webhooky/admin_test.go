package webhooky

import (
	"context"
	"strings"
	"testing"
)

func TestAdminCredentialMustBePair(t *testing.T) {
	if _, err := NewAdminClient(Config{BaseURL: "http://x", Credential: "no-colon"}); err == nil {
		t.Error("NewAdminClient accepted a credential without a colon")
	}
	// An empty credential is legitimate: the identity-provider path uses
	// headers instead.
	if _, err := NewAdminClient(Config{BaseURL: "http://x"}); err != nil {
		t.Errorf("NewAdminClient without a credential: %v", err)
	}
}

func TestAdminListsUnwrapEnvelopes(t *testing.T) {
	server, seen := stubServer(t, 200, `{"destinations":[{"id":"d1","name":"prod","fetchUuid":"f1"}]}`)
	destinations, err := testAdmin(t, server.URL).ListDestinations(context.Background())
	if err != nil {
		t.Fatalf("ListDestinations: %v", err)
	}
	if seen.path != "/_admin/api/destinations" {
		t.Errorf("path = %q", seen.path)
	}
	if seen.auth != "Bearer admin-1:admin-secret" {
		t.Errorf("authorization = %q", seen.auth)
	}
	if len(destinations) != 1 || destinations[0].ID != "d1" || destinations[0].FetchUUID != "f1" {
		t.Fatalf("destinations = %+v", destinations)
	}
}

func TestCreateDestinationSendsJSONBody(t *testing.T) {
	server, seen := stubServer(t, 201, `{"id":"d1","name":"prod"}`)
	_, err := testAdmin(t, server.URL).CreateDestination(context.Background(), CreateDestinationInput{
		Name:         "prod",
		VendorAddon:  "wrike",
		VendorConfig: []byte(`{"secret":"s"}`),
	})
	if err != nil {
		t.Fatalf("CreateDestination: %v", err)
	}
	if seen.method != "POST" {
		t.Errorf("method = %q", seen.method)
	}
	if seen.contentType != "application/json" {
		t.Errorf("content-type = %q", seen.contentType)
	}
	for _, want := range []string{`"name":"prod"`, `"vendorAddon":"wrike"`, `"secret":"s"`} {
		if !strings.Contains(seen.body, want) {
			t.Errorf("body %s is missing %s", seen.body, want)
		}
	}
	// An omitted optional must not appear at all, so the server keeps its
	// default rather than receiving an explicit null.
	if strings.Contains(seen.body, "destinationAddon") {
		t.Errorf("body %s should omit an unset destinationAddon", seen.body)
	}
}

func TestBodylessWritesDeclareJSONForCsrf(t *testing.T) {
	// The server's CSRF rule accepts an identity-provider write only with a
	// matching Origin or content-type: application/json. These calls have no
	// body, so the header is the only way through.
	cases := []struct {
		name string
		call func(*AdminClient) error
	}{
		{"rotate fetch uuid", func(a *AdminClient) error {
			_, err := a.RotateFetchUUID(context.Background(), "d1")
			return err
		}},
		{"grant", func(a *AdminClient) error {
			_, err := a.GrantDestination(context.Background(), "u1", "d1")
			return err
		}},
		{"delete destination", func(a *AdminClient) error {
			return a.DeleteDestination(context.Background(), "d1")
		}},
		{"retry relay", func(a *AdminClient) error {
			_, err := a.RetryRelay(context.Background(), "r1")
			return err
		}},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			server, seen := stubServer(t, 200, `{}`)
			if err := testCase.call(testAdmin(t, server.URL)); err != nil {
				t.Fatalf("call: %v", err)
			}
			if seen.contentType != "application/json" {
				t.Errorf("content-type = %q, want application/json", seen.contentType)
			}
		})
	}
}

func TestPathSegmentsAreEscaped(t *testing.T) {
	// An admin user subject is an email or an IdP subject and can contain
	// characters that would otherwise change the route.
	server, seen := stubServer(t, 204, "")
	if err := testAdmin(t, server.URL).DeleteAdminUser(context.Background(), "ops user@example.com"); err != nil {
		t.Fatalf("DeleteAdminUser: %v", err)
	}
	// The server must decode the segment back to the exact subject...
	if seen.path != "/_admin/api/admin-users/ops user@example.com" {
		t.Errorf("decoded path = %q", seen.path)
	}
	// ...which requires the space to have been percent-encoded on the wire.
	if !strings.Contains(seen.rawURI, "ops%20user@example.com") {
		t.Errorf("raw request URI = %q, want the space percent-encoded", seen.rawURI)
	}
}

func TestUploadAddonUsesMultipartAndOrigin(t *testing.T) {
	server, seen := stubServer(t, 201, `{"name":"acme","version":"1.0.0","kind":"vendor"}`)
	addon, err := testAdmin(t, server.URL).UploadAddon(context.Background(), "acme.zip", []byte("PK\x03\x04stub"))
	if err != nil {
		t.Fatalf("UploadAddon: %v", err)
	}
	if addon.Name != "acme" {
		t.Errorf("addon = %+v", addon)
	}
	if !strings.HasPrefix(seen.contentType, "multipart/form-data") {
		t.Errorf("content-type = %q", seen.contentType)
	}
	// Multipart cannot use the JSON content type, so the Origin header is what
	// clears the server's CSRF rule on the identity-provider path.
	if seen.origin == "" {
		t.Error("multipart upload did not send an Origin header")
	}
	for _, want := range []string{`name="package"`, `filename="acme.zip"`, "PK"} {
		if !strings.Contains(seen.body, want) {
			t.Errorf("multipart body is missing %q", want)
		}
	}
}

func TestListRelaysFiltersByDestination(t *testing.T) {
	server, seen := stubServer(t, 200, `{"relays":[]}`)
	if _, err := testAdmin(t, server.URL).ListRelays(context.Background(), "dest-9"); err != nil {
		t.Fatalf("ListRelays: %v", err)
	}
	if seen.rawQuery != "destinationId=dest-9" {
		t.Errorf("query = %q", seen.rawQuery)
	}

	server2, seen2 := stubServer(t, 200, `{"relays":[]}`)
	if _, err := testAdmin(t, server2.URL).ListRelays(context.Background(), ""); err != nil {
		t.Fatalf("ListRelays: %v", err)
	}
	if seen2.rawQuery != "" {
		t.Errorf("unfiltered query = %q, want empty", seen2.rawQuery)
	}
}

func TestCreatedSecretsAreDecoded(t *testing.T) {
	server, _ := stubServer(t, 201,
		`{"id":"k1","label":"ci","enabled":true,"createdAt":5,"grants":[],"secret":"s3cr3t","credential":"k1:s3cr3t"}`)
	created, err := testAdmin(t, server.URL).CreateAPIUser(context.Background(), "ci")
	if err != nil {
		t.Fatalf("CreateAPIUser: %v", err)
	}
	if created.ID != "k1" || created.Label != "ci" {
		t.Errorf("embedded user fields not decoded: %+v", created)
	}
	if created.Secret != "s3cr3t" || created.Credential != "k1:s3cr3t" {
		t.Errorf("secret fields not decoded: %+v", created)
	}
}

func TestNoContentResponseIsNotADecodeError(t *testing.T) {
	server, _ := stubServer(t, 204, "")
	if err := testAdmin(t, server.URL).DeleteRelay(context.Background(), "r1"); err != nil {
		t.Fatalf("DeleteRelay: %v", err)
	}
}
