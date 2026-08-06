import XCTest

@testable import WebHooky

private let baseURL = "https://hooks.example.test"

/// A complete destination as the server renders it.
///
/// The Swift models decode strictly - a missing field is an error rather than a
/// silent zero - so the fixtures mirror the server's full projection.
private func destinationJSON(
    id: String = "d1",
    fetchUuid: String = "f1"
) -> [String: Any] {
    [
        "id": id,
        "name": "prod",
        "vendorAddon": "wrike",
        "destinationAddon": NSNull(),
        "inboundUuid": "in-1",
        "inboundPath": "/wrike/in-1",
        "fetchUuid": fetchUuid,
        "fetchPath": "/_get/\(fetchUuid)",
        "streamPath": "/_ws/\(fetchUuid)",
        "vendorConfig": [:],
        "destinationConfig": [:],
        "retentionSeconds": NSNull(),
        "enabled": true,
        "createdAt": 1,
        "createdBy": NSNull(),
    ]
}

private func addonJSON() -> [String: Any] {
    [
        "name": "acme",
        "version": "1.0.0",
        "kind": "vendor",
        "description": "",
        "source": "installed",
        "acceptsSchema": NSNull(),
        "returnsSchema": NSNull(),
        "configSchema": NSNull(),
        "hasAuthenticate": true,
        "hasTransform": false,
    ]
}

final class AdminClientTests: XCTestCase {
    private func admin() throws -> WebHookyAdminClient {
        try WebHookyAdminClient(
            config: AdminClientConfig(
                baseURL: baseURL, credential: "admin-1:admin-secret"),
            session: StubURLProtocol.session()
        )
    }

    func testCredentialMustBeAPair() {
        XCTAssertThrowsError(
            try WebHookyAdminClient(
                config: AdminClientConfig(baseURL: baseURL, credential: "no-colon")
            )
        )
    }

    func testCredentialMayBeAbsentWithIdentityHeaders() throws {
        // A deployment fronted by an identity-provider proxy authenticates
        // through headers, so no credential is legitimate there.
        let client = try WebHookyAdminClient(
            config: AdminClientConfig(
                baseURL: baseURL,
                headers: ["cf-access-authenticated-user-email": "ops@example.com"]
            )
        )
        XCTAssertEqual(client.configuration.authorization, "")
    }

    func testNoCredentialsAtAllIsRejected() {
        XCTAssertThrowsError(
            try WebHookyAdminClient(config: AdminClientConfig(baseURL: baseURL))
        )
    }

    func testListEndpointsUnwrapTheEnvelope() async throws {
        StubURLProtocol.reset(json: ["destinations": [destinationJSON()]])
        let destinations = try await admin().listDestinations()

        XCTAssertEqual(StubURLProtocol.seen.path, "/_admin/api/destinations")
        XCTAssertEqual(
            StubURLProtocol.seen.header("authorization"), "Bearer admin-1:admin-secret")
        XCTAssertEqual(destinations.count, 1)
        XCTAssertEqual(destinations[0].id, "d1")
        XCTAssertEqual(destinations[0].fetchUuid, "f1")
    }

    func testCreateOmitsUnsetOptionals() async throws {
        StubURLProtocol.reset(status: 201, json: destinationJSON())
        _ = try await admin().createDestination(
            CreateDestinationInput(
                name: "prod",
                vendorAddon: "wrike",
                vendorConfig: .object(["secret": .string("s")])
            )
        )

        XCTAssertEqual(StubURLProtocol.seen.method, "POST")
        XCTAssertEqual(StubURLProtocol.seen.header("content-type"), "application/json")
        let body = StubURLProtocol.seen.bodyText
        XCTAssertTrue(body.contains("\"name\":\"prod\""))
        XCTAssertTrue(body.contains("\"vendorAddon\":\"wrike\""))
        // An omitted optional must not appear at all, so the server keeps its
        // default rather than receiving an explicit null.
        XCTAssertFalse(body.contains("destinationAddon"))
    }

    func testBodylessWritesDeclareJSONForCsrf() async throws {
        // The server's CSRF rule accepts an identity-provider write only with a
        // matching Origin or content-type: application/json. These calls have
        // no body, so the header is the only way through.
        StubURLProtocol.reset(json: destinationJSON())
        _ = try await admin().rotateFetchUUID(id: "d1")
        XCTAssertEqual(StubURLProtocol.seen.header("content-type"), "application/json")

        StubURLProtocol.reset(status: 204)
        try await admin().deleteDestination(id: "d1")
        XCTAssertEqual(StubURLProtocol.seen.header("content-type"), "application/json")

        StubURLProtocol.reset(json: ["requeued": 2])
        _ = try await admin().retryRelay(id: "r1")
        XCTAssertEqual(StubURLProtocol.seen.header("content-type"), "application/json")
    }

    func testPathSegmentsArePercentEncoded() async throws {
        // An admin subject is an email or an IdP subject and can contain
        // characters that would otherwise change the route.
        StubURLProtocol.reset(status: 204)
        try await admin().deleteAdminUser(subject: "ops user@example.com")
        XCTAssertEqual(
            StubURLProtocol.seen.url?.absoluteString,
            "\(baseURL)/_admin/api/admin-users/ops%20user%40example.com"
        )
    }

    func testUploadAddonUsesMultipartAndOrigin() async throws {
        StubURLProtocol.reset(status: 201, json: addonJSON())
        let addon = try await admin().uploadAddon(
            fileName: "acme.zip", archive: Data("PKstub".utf8))

        XCTAssertEqual(addon.name, "acme")
        XCTAssertTrue(
            StubURLProtocol.seen.header("content-type")?
                .hasPrefix("multipart/form-data") ?? false
        )
        // Multipart cannot use the JSON content type, so the Origin header is
        // what clears the server's CSRF rule on the identity-provider path.
        XCTAssertEqual(StubURLProtocol.seen.header("origin"), baseURL)
        let body = StubURLProtocol.seen.bodyText
        XCTAssertTrue(body.contains("name=\"package\""))
        XCTAssertTrue(body.contains("filename=\"acme.zip\""))
        XCTAssertTrue(body.contains("PK"))
    }

    func testListRelaysFiltersByDestinationOnlyWhenAsked() async throws {
        StubURLProtocol.reset(json: ["relays": []])
        _ = try await admin().listRelays(destinationID: "dest-9")
        XCTAssertEqual(StubURLProtocol.seen.query, "destinationId=dest-9")

        StubURLProtocol.reset(json: ["relays": []])
        _ = try await admin().listRelays()
        XCTAssertEqual(StubURLProtocol.seen.query, "")
    }

    func testSecretsReturnedOnceAreDecoded() async throws {
        StubURLProtocol.reset(
            status: 201,
            json: [
                "id": "k1", "label": "ci", "enabled": true, "createdAt": 5,
                "grants": [], "secret": "s3cr3t", "credential": "k1:s3cr3t",
            ]
        )
        let created = try await admin().createApiUser(label: "ci")

        XCTAssertEqual(created.id, "k1")
        XCTAssertEqual(created.secret, "s3cr3t")
        XCTAssertEqual(created.credential, "k1:s3cr3t")
    }

    func testNoContentResponseIsNotADecodeError() async throws {
        StubURLProtocol.reset(status: 204)
        try await admin().deleteRelay(id: "r1")
    }

    func testRelayDeliveriesDecodeWithStats() async throws {
        StubURLProtocol.reset(
            json: [
                "deliveries": [
                    [
                        "id": "dl1", "relayId": "r1", "recordId": "rec1", "t": 3,
                        "status": "failed", "attempts": 5, "nextAttemptAt": 9,
                        "lastStatusCode": 500, "lastError": "boom",
                        "createdAt": 1, "updatedAt": 2,
                        "deliveredAt": NSNull(),
                    ]
                ],
                "stats": ["pending": 1, "delivered": 2, "failed": 3],
            ]
        )
        let page = try await admin().listRelayDeliveries(id: "r1", limit: 10)

        XCTAssertEqual(StubURLProtocol.seen.query, "limit=10")
        XCTAssertEqual(page.stats.failed, 3)
        XCTAssertEqual(page.deliveries[0].lastStatusCode, 500)
        XCTAssertNil(page.deliveries[0].deliveredAt)
    }

    func testRetryReportsTheRequeuedCount() async throws {
        StubURLProtocol.reset(json: ["requeued": 4])
        let requeued = try await admin().retryRelay(id: "r1")
        XCTAssertEqual(requeued, 4)
    }
}
