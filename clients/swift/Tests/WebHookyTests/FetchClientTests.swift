import XCTest

@testable import WebHooky

private let baseURL = "https://hooks.example.test"

final class ConfigTests: XCTestCase {
    func testBaseURLNormalization() throws {
        let cases: [(String, String, String)] = [
            ("http://localhost:8787", "http://localhost:8787", "ws://localhost:8787"),
            (
                "https://hooks.example.com/", "https://hooks.example.com",
                "wss://hooks.example.com"
            ),
            (
                "wss://hooks.example.com//", "https://hooks.example.com",
                "wss://hooks.example.com"
            ),
            ("http://host:1/prefix/", "http://host:1/prefix", "ws://host:1/prefix"),
        ]
        for (raw, http, ws) in cases {
            let urls = try normalizeBaseURL(raw)
            XCTAssertEqual(urls.http, http, "http form of \(raw)")
            XCTAssertEqual(urls.ws, ws, "ws form of \(raw)")
        }
    }

    func testBaseURLRejectsBadInput() {
        for raw in ["", "   ", "ftp://example.com", "no-scheme-or-host"] {
            XCTAssertThrowsError(try normalizeBaseURL(raw), "accepted \(raw)")
        }
    }

    func testMissingFetchCredentialsAreRejected() {
        XCTAssertThrowsError(
            try WebHookyFetchClient(
                config: FetchClientConfig(baseURL: baseURL, apiKey: "", apiSecret: "s")
            )
        )
    }

    func testSplitCredential() throws {
        let pair = try splitCredential("key-1:sec-1")
        XCTAssertEqual(pair.keyID, "key-1")
        XCTAssertEqual(pair.secret, "sec-1")
        XCTAssertThrowsError(try splitCredential("no-colon"))
        XCTAssertThrowsError(try splitCredential(":leading"))
        XCTAssertThrowsError(try splitCredential("trailing:"))
    }

    func testCallerHeadersNeverOverrideTheCredential() throws {
        let resolved = try ResolvedConfig.forFetch(
            FetchClientConfig(
                baseURL: baseURL,
                apiKey: "key-1",
                apiSecret: "sec-1",
                headers: ["authorization": "Bearer attacker:owned"]
            )
        )
        // The credentials the caller passed explicitly must win over a header
        // that happens to share the name.
        XCTAssertEqual(
            resolved.requestHeaders(contentType: nil)["authorization"],
            "Bearer key-1:sec-1"
        )
    }
}

final class RecordQueryTests: XCTestCase {
    func testDefaultQuerySendsNothing() {
        // The server has its own defaults; sending them back would only risk
        // disagreeing with the version deployed.
        XCTAssertTrue(
            WebHookyFetchClient.queryItems(for: RecordQuery()).isEmpty
        )
    }

    func testQueryParameters() {
        let params = WebHookyFetchClient.queryItems(
            for: RecordQuery(
                onlyUnfetched: true,
                markFetched: false,
                from: .seconds(100),
                to: .date(Date(timeIntervalSince1970: 200)),
                limit: 25
            )
        )
        XCTAssertEqual(params["only_unfetched"], "true")
        XCTAssertEqual(params["mark_fetched"], "false")
        XCTAssertEqual(params["from"], "100")
        XCTAssertEqual(params["to"], "200")
        XCTAssertEqual(params["limit"], "25")
    }

    func testISO8601BoundsPassThrough() {
        // The server parses ISO-8601 itself, so a string bound is forwarded
        // rather than reinterpreted by a second parser here.
        let params = WebHookyFetchClient.queryItems(
            for: RecordQuery(from: .iso8601("2026-01-01T00:00:00Z"))
        )
        XCTAssertEqual(params["from"], "2026-01-01T00:00:00Z")
    }
}

final class FetchRequestTests: XCTestCase {
    private func client() throws -> WebHookyFetchClient {
        try WebHookyFetchClient(
            config: FetchClientConfig(
                baseURL: baseURL, apiKey: "key-1", apiSecret: "sec-1"),
            session: StubURLProtocol.session()
        )
    }

    func testRecordsSendsBearerAndBareURL() async throws {
        StubURLProtocol.reset(
            json: ["records": [["t": 10, "fetched": false, "payload": ["a": 1]]]]
        )
        let records = try await client().records(fetchUUID: "fetch-uuid")

        XCTAssertEqual(StubURLProtocol.seen.path, "/_get/fetch-uuid")
        // A default query must send nothing: the server's own defaults apply.
        XCTAssertEqual(StubURLProtocol.seen.query, "")
        XCTAssertEqual(
            StubURLProtocol.seen.header("authorization"), "Bearer key-1:sec-1")
        XCTAssertTrue(
            StubURLProtocol.seen.header("user-agent")?.hasPrefix("webhooky-swift/")
                ?? false
        )
        XCTAssertEqual(records.count, 1)
        XCTAssertEqual(records[0].t, 10)
        XCTAssertEqual(records[0].fetched, false)
        XCTAssertEqual(records[0].payload["a"]?.intValue, 1)
    }

    func testEmptyResultDecodesToEmptyArray() async throws {
        StubURLProtocol.reset(json: ["records": []])
        let records = try await client().records(fetchUUID: "uuid")
        XCTAssertTrue(records.isEmpty)
    }

    func testErrorEnvelopeIsDecoded() async throws {
        StubURLProtocol.reset(
            status: 403,
            json: [
                "error": [
                    "kind": "forbidden",
                    "message": "API user is not authorized for this destination",
                ]
            ]
        )

        do {
            _ = try await client().records(fetchUUID: "uuid")
            XCTFail("expected an error")
        } catch let error as WebhookyError {
            XCTAssertEqual(error.status, 403)
            XCTAssertEqual(error.kind, "forbidden")
            XCTAssertTrue(error.isForbidden)
            XCTAssertTrue(error.message.contains("not authorized"))
        }
    }

    func testNonEnvelopeErrorBodyStillReportsTheStatus() async throws {
        // A proxy answering with HTML must not produce an empty, useless error.
        StubURLProtocol.reset(status: 502, text: "<html>bad gateway</html>")
        do {
            _ = try await client().records(fetchUUID: "uuid")
            XCTFail("expected an error")
        } catch let error as WebhookyError {
            XCTAssertEqual(error.status, 502)
            XCTAssertEqual(error.kind, "")
            XCTAssertTrue(error.message.contains("502"))
        }
    }

    func testExtraHeadersAreSent() async throws {
        StubURLProtocol.reset(json: ["records": []])
        let configured = try WebHookyFetchClient(
            config: FetchClientConfig(
                baseURL: baseURL,
                apiKey: "key-1",
                apiSecret: "sec-1",
                headers: ["cf-access-authenticated-user-email": "ops@example.com"],
                userAgent: "custom-agent/9"
            ),
            session: StubURLProtocol.session()
        )
        _ = try await configured.records(fetchUUID: "uuid")

        XCTAssertEqual(
            StubURLProtocol.seen.header("cf-access-authenticated-user-email"),
            "ops@example.com"
        )
        XCTAssertEqual(StubURLProtocol.seen.header("user-agent"), "custom-agent/9")
    }
}
