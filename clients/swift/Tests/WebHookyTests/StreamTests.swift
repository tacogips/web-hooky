import XCTest

@testable import WebHooky

private let baseURL = "https://hooks.example.test"

final class StreamTests: XCTestCase {
    private func config() throws -> ResolvedConfig {
        try ResolvedConfig.forFetch(
            FetchClientConfig(baseURL: baseURL, apiKey: "key-1", apiSecret: "sec-1")
        )
    }

    func testStreamURLDefaultsToHeaderCredentials() throws {
        // The header form keeps credentials out of proxy access logs, so it is
        // the default and the URL must stay clean.
        let url = streamURL(
            config: try config(), fetchUUID: "fetch-uuid", queryCredentials: false)
        XCTAssertEqual(url, "wss://hooks.example.test/_ws/fetch-uuid")
    }

    func testStreamURLQueryFallback() throws {
        let url = streamURL(
            config: try config(), fetchUUID: "fetch-uuid", queryCredentials: true)
        XCTAssertTrue(url.contains("api_key=key-1"))
        XCTAssertTrue(url.contains("api_secret=sec-1"))
    }

    func testFrameDecoding() throws {
        XCTAssertEqual(
            try decodeStreamFrame("{\"type\":\"ready\"}"),
            StreamFrame(type: "ready", record: nil)
        )

        let frame = try decodeStreamFrame(
            "{\"type\":\"record\",\"record\":{\"t\":3,\"fetched\":false,\"payload\":1}}"
        )
        XCTAssertEqual(frame.type, "record")
        XCTAssertEqual(frame.record?.t, 3)
        XCTAssertEqual(frame.record?.payload.intValue, 1)

        // A server that grows a new frame kind must not break an older client.
        XCTAssertEqual(
            try decodeStreamFrame("{\"type\":\"future-kind\"}"),
            StreamFrame(type: "future-kind", record: nil)
        )
    }

    func testMalformedFramesAreRejected() {
        XCTAssertThrowsError(try decodeStreamFrame("not json"))
        XCTAssertThrowsError(try decodeStreamFrame("{\"type\":\"record\"}"))
    }

    func testBackoffIsExponentialAndCapped() {
        XCTAssertEqual(streamBackoff(attempt: 1, initial: 0.5, maximum: 30), 0.5)
        XCTAssertEqual(streamBackoff(attempt: 3, initial: 0.5, maximum: 30), 2.0)
        // A long-lived stream must not grow an absurd delay.
        XCTAssertEqual(streamBackoff(attempt: 500, initial: 0.5, maximum: 30), 30)
    }
}

final class AnyJSONTests: XCTestCase {
    func testRoundTripsWithoutLosingShape() throws {
        let source = """
            {"n":1,"s":"x","b":true,"nil":null,"a":[1,2],"o":{"k":"v"}}
            """
        let value = try JSONDecoder().decode(AnyJSON.self, from: Data(source.utf8))

        XCTAssertEqual(value["n"]?.intValue, 1)
        XCTAssertEqual(value["s"]?.stringValue, "x")
        XCTAssertEqual(value["b"]?.boolValue, true)
        XCTAssertEqual(value["nil"], AnyJSON.null)
        XCTAssertEqual(value["a"]?.arrayValue?.count, 2)
        XCTAssertEqual(value["o"]?["k"]?.stringValue, "v")

        // Whole numbers must not come back as 1.0: a unix timestamp rendered in
        // scientific notation would be rejected by the server on the way back.
        let encoded = String(decoding: try JSONEncoder().encode(value), as: UTF8.self)
        XCTAssertTrue(encoded.contains("\"n\":1"))
        XCTAssertFalse(encoded.contains("1e"))
    }

    func testFromSwiftValues() {
        let value = AnyJSON.from(["secret": "s", "retries": 3, "on": true])
        XCTAssertEqual(value["secret"]?.stringValue, "s")
        XCTAssertEqual(value["retries"]?.intValue, 3)
        XCTAssertEqual(value["on"]?.boolValue, true)
    }
}
