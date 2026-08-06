import Foundation

#if canImport(FoundationNetworking)
    import FoundationNetworking
#endif

/// One HTTP request to a web-hooky server.
struct RequestSpec {
    let method: String
    let path: String
    var query: [String: String] = [:]
    /// Encoded as JSON when present.
    var body: Data?
    /// A pre-encoded body, used by the multipart addon upload.
    var rawBody: Data?
    var contentType: String?
    /// Adds an `Origin` header matching the server.
    ///
    /// The server's CSRF rule accepts an identity-provider write either with a
    /// matching `Origin` or with `content-type: application/json`. A multipart
    /// upload cannot use the latter, so it uses the former.
    var sendOrigin = false

    private static let safeMethods: Set<String> = ["GET", "HEAD", "OPTIONS"]

    /// The content type to send, defaulting writes to JSON.
    ///
    /// Bodyless writes (rotate, grant, delete) still declare JSON so the
    /// identity-provider path clears the server's CSRF check.
    var resolvedContentType: String? {
        if let contentType { return contentType }
        if body != nil { return "application/json" }
        return Self.safeMethods.contains(method.uppercased())
            ? nil : "application/json"
    }
}

/// Performs authenticated JSON requests against one server.
struct Transport: Sendable {
    let config: ResolvedConfig
    let session: URLSession

    init(config: ResolvedConfig, session: URLSession? = nil) {
        self.config = config
        if let session {
            self.session = session
        } else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.timeoutIntervalForRequest = config.timeout
            self.session = URLSession(configuration: configuration)
        }
    }

    private func buildRequest(_ spec: RequestSpec) throws -> URLRequest {
        guard var components = URLComponents(string: config.urls.http + spec.path)
        else {
            throw WebhookyError(message: "failed to build request URL for \(spec.path)")
        }
        if spec.query.isEmpty == false {
            components.queryItems = spec.query
                .sorted { $0.key < $1.key }
                .map { URLQueryItem(name: $0.key, value: $0.value) }
        }
        guard let url = components.url else {
            throw WebhookyError(message: "failed to build request URL for \(spec.path)")
        }

        var request = URLRequest(url: url)
        request.httpMethod = spec.method
        request.timeoutInterval = config.timeout
        for (name, value) in config.requestHeaders(
            contentType: spec.resolvedContentType)
        {
            request.setValue(value, forHTTPHeaderField: name)
        }
        if spec.sendOrigin, let origin = URL(string: config.urls.http),
            let scheme = origin.scheme, let host = origin.host
        {
            let port = origin.port.map { ":\($0)" } ?? ""
            request.setValue("\(scheme)://\(host)\(port)", forHTTPHeaderField: "origin")
        }
        request.httpBody = spec.rawBody ?? spec.body
        return request
    }

    /// Performs the request and returns the body of a 2xx response.
    func send(_ spec: RequestSpec) async throws -> Data {
        let request = try buildRequest(spec)

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch let error as WebhookyError {
            throw error
        } catch {
            throw WebhookyError(message: "request failed: \(error.localizedDescription)")
        }

        guard let http = response as? HTTPURLResponse else {
            throw WebhookyError(message: "response was not an HTTP response")
        }
        guard (200..<300).contains(http.statusCode) else {
            throw WebhookyError.fromResponse(status: http.statusCode, body: data)
        }
        return data
    }

    /// Performs the request and decodes its JSON response.
    func decode<T: Decodable>(_ type: T.Type, _ spec: RequestSpec) async throws -> T {
        let data = try await send(spec)
        guard data.isEmpty == false else {
            throw WebhookyError(
                message: "expected a JSON response body but the server sent none"
            )
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw WebhookyError(message: "failed to decode response: \(error)")
        }
    }

    /// Performs the request and discards its response body.
    func discard(_ spec: RequestSpec) async throws {
        _ = try await send(spec)
    }
}

/// Percent-encodes a value used as a single URL path segment.
func pathSegment(_ value: String) -> String {
    // `.urlPathAllowed` keeps `/` and other separators, which would let a
    // subject or an addon name change the route it is interpolated into.
    var allowed = CharacterSet.alphanumerics
    allowed.insert(charactersIn: "-._~")
    return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
}

/// Encodes a value as JSON, omitting `nil` optionals.
///
/// `JSONEncoder` already skips `nil` optionals, which is exactly the behaviour
/// the partial-update inputs need: an unset field must not reach the wire as an
/// explicit null.
func encodeBody<T: Encodable>(_ value: T) throws -> Data {
    do {
        return try JSONEncoder().encode(value)
    } catch {
        throw WebhookyError(message: "failed to encode request body: \(error)")
    }
}
