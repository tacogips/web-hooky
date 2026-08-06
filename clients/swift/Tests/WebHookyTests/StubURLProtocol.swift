import Foundation

#if canImport(FoundationNetworking)
    import FoundationNetworking
#endif

/// A `URLProtocol` that records the request and answers with a fixed response.
///
/// Driving the real `URLSession` stack (rather than swapping the transport out)
/// keeps the tests honest about headers, query strings and body encoding, which
/// is exactly what the client is responsible for getting right.
final class StubURLProtocol: URLProtocol {
    struct Seen {
        var url: URL?
        var method: String = ""
        var headers: [String: String] = [:]
        var body: Data = Data()

        var query: String { url?.query ?? "" }
        var path: String { url?.path ?? "" }
        var bodyText: String { String(decoding: body, as: UTF8.self) }

        func header(_ name: String) -> String? {
            headers.first { $0.key.lowercased() == name.lowercased() }?.value
        }
    }

    /// The stub is process-wide because `URLProtocol` is instantiated by the
    /// session; the tests are serial, so one slot is enough.
    nonisolated(unsafe) static var status = 200
    nonisolated(unsafe) static var body = Data()
    nonisolated(unsafe) static var seen = Seen()

    static func reset(status: Int = 200, json: Any? = nil) {
        Self.status = status
        Self.seen = Seen()
        if let json {
            Self.body = (try? JSONSerialization.data(withJSONObject: json)) ?? Data()
        } else {
            Self.body = Data()
        }
    }

    static func reset(status: Int, text: String) {
        Self.status = status
        Self.seen = Seen()
        Self.body = Data(text.utf8)
    }

    /// Builds a session wired to this stub.
    static func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        return URLSession(configuration: configuration)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        var seen = Seen()
        seen.url = request.url
        seen.method = request.httpMethod ?? ""
        seen.headers = request.allHTTPHeaderFields ?? [:]
        // URLSession moves a small httpBody into a stream, so both are read.
        if let body = request.httpBody {
            seen.body = body
        } else if let stream = request.httpBodyStream {
            seen.body = StubURLProtocol.drain(stream)
        }
        StubURLProtocol.seen = seen

        let response = HTTPURLResponse(
            url: request.url ?? URL(fileURLWithPath: "/"),
            statusCode: StubURLProtocol.status,
            httpVersion: "HTTP/1.1",
            headerFields: ["content-type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        if StubURLProtocol.body.isEmpty == false {
            client?.urlProtocol(self, didLoad: StubURLProtocol.body)
        }
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func drain(_ stream: InputStream) -> Data {
        stream.open()
        defer { stream.close() }
        var data = Data()
        let size = 4096
        var buffer = [UInt8](repeating: 0, count: size)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: size)
            if read <= 0 { break }
            data.append(contentsOf: buffer[0..<read])
        }
        return data
    }
}
