import Foundation

#if canImport(FoundationNetworking)
    import FoundationNetworking
#endif

/// RFC 6455 close code the server uses when a credential or grant is revoked.
public let webHookyPolicyViolationCode = 1008

/// Configuration for one stream.
public struct StreamOptions: Sendable {
    /// Reconnect with capped exponential backoff after a transport failure.
    ///
    /// A policy-violation close (1008) always ends the stream even when this is
    /// set: the server closes with that code when the credential or grant was
    /// revoked, and retrying would only hammer a server that has already
    /// refused.
    public var reconnect: Bool
    public var initialBackoff: TimeInterval
    public var maxBackoff: TimeInterval
    /// Send credentials as `?api_key=&api_secret=` instead of a header.
    ///
    /// The header is the default because a query string ends up in proxy and
    /// server access logs; use this only where a proxy strips `Authorization`
    /// from upgrade requests.
    public var queryCredentials: Bool
    /// Stop after this many records; `nil` streams until the task is cancelled.
    public var maxRecords: Int?
    /// Fires once per successful connection, on the server's ready frame.
    public var onReady: (@Sendable () -> Void)?
    /// Fires before each retry with the attempt number and the previous error.
    public var onReconnect: (@Sendable (Int, Error) -> Void)?

    public init(
        reconnect: Bool = false,
        initialBackoff: TimeInterval = 0.5,
        maxBackoff: TimeInterval = 30,
        queryCredentials: Bool = false,
        maxRecords: Int? = nil,
        onReady: (@Sendable () -> Void)? = nil,
        onReconnect: (@Sendable (Int, Error) -> Void)? = nil
    ) {
        self.reconnect = reconnect
        self.initialBackoff = initialBackoff
        self.maxBackoff = maxBackoff
        self.queryCredentials = queryCredentials
        self.maxRecords = maxRecords
        self.onReady = onReady
        self.onReconnect = onReconnect
    }
}

/// The server closed the socket with a policy violation (1008).
///
/// The credential or the grant behind this stream is no longer valid;
/// reconnecting will not help.
public let webHookyStreamClosedByServer = WebhookyError(
    message: "stream closed by server policy (credential or grant revoked)",
    kind: WebhookyErrorKind.forbidden.rawValue
)

/// One decoded server frame.
public struct StreamFrame: Equatable, Sendable {
    public let type: String
    /// `nil` for anything that is not a record frame, including frame kinds a
    /// newer server may add.
    public let record: WebhookRecord?
}

/// Decodes one server frame.
public func decodeStreamFrame(_ raw: String) throws -> StreamFrame {
    guard let data = raw.data(using: .utf8) else {
        throw WebhookyError(message: "stream frame is not valid UTF-8")
    }
    guard
        let object = try? JSONSerialization.jsonObject(with: data)
            as? [String: Any]
    else {
        throw WebhookyError(message: "stream frame is not a JSON object")
    }

    let type = object["type"] as? String ?? ""
    guard type == "record" else {
        // An unknown frame type yields no record and is ignored by the caller,
        // so a server that grows a new frame kind does not break this client.
        return StreamFrame(type: type, record: nil)
    }
    guard let recordObject = object["record"],
        let recordData = try? JSONSerialization.data(withJSONObject: recordObject),
        let record = try? JSONDecoder().decode(WebhookRecord.self, from: recordData)
    else {
        throw WebhookyError(message: "stream \"record\" frame carried no record object")
    }
    return StreamFrame(type: type, record: record)
}

/// Capped exponential backoff for reconnect attempt `attempt` (1-based).
public func streamBackoff(
    attempt: Int,
    initial: TimeInterval,
    maximum: TimeInterval
) -> TimeInterval {
    let exponent = min(max(attempt - 1, 0), 20)
    return min(initial * pow(2, Double(exponent)), maximum)
}

/// Builds the `/_ws/{fetchUuid}` URL for one stream.
func streamURL(
    config: ResolvedConfig,
    fetchUUID: String,
    queryCredentials: Bool
) -> String {
    let base = "\(config.urls.ws)/_ws/\(pathSegment(fetchUUID))"
    guard queryCredentials else { return base }

    var token = config.authorization
    if token.lowercased().hasPrefix("bearer ") {
        token = String(token.dropFirst("bearer ".count))
    }
    guard let pair = try? splitCredential(token) else { return base }

    var components = URLComponents(string: base)
    components?.queryItems = [
        URLQueryItem(name: "api_key", value: pair.keyID),
        URLQueryItem(name: "api_secret", value: pair.secret),
    ]
    return components?.url?.absoluteString ?? base
}

/// Drives one `URLSessionWebSocketTask` and republishes its frames.
///
/// The task is built from a `URLRequest`, so the handshake carries the
/// `Authorization` header by default, keeping credentials out of access logs.
struct RecordStream {
    let config: ResolvedConfig
    let fetchUUID: String
    let options: StreamOptions

    func makeStream() -> AsyncThrowingStream<WebhookRecord, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    try await run(continuation: continuation)
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func makeRequest() -> URLRequest {
        let url =
            URL(
                string: streamURL(
                    config: config,
                    fetchUUID: fetchUUID,
                    queryCredentials: options.queryCredentials
                )
            ) ?? URL(fileURLToPath: "/")
        var request = URLRequest(url: url)
        request.setValue(config.userAgent, forHTTPHeaderField: "user-agent")
        for (name, value) in config.headers {
            request.setValue(value, forHTTPHeaderField: name)
        }
        if options.queryCredentials == false, config.authorization.isEmpty == false {
            request.setValue(config.authorization, forHTTPHeaderField: "authorization")
        }
        return request
    }

    private func run(
        continuation: AsyncThrowingStream<WebhookRecord, Error>.Continuation
    ) async throws {
        var delivered = 0
        var attempt = 0

        while true {
            let cause: Error
            do {
                try await runConnection(
                    continuation: continuation,
                    delivered: &delivered
                )
                if let maximum = options.maxRecords, delivered >= maximum {
                    return
                }
                guard options.reconnect else { return }
                cause = WebhookyError(message: "stream closed by the server")
            } catch let error as WebhookyError
                where error.kind == webHookyStreamClosedByServer.kind
                    && error.message == webHookyStreamClosedByServer.message
            {
                // A revoked credential is terminal: retrying cannot fix it.
                throw error
            } catch {
                try Task.checkCancellation()
                guard options.reconnect else { throw error }
                cause = error
            }

            attempt += 1
            options.onReconnect?(attempt, cause)
            let delay = streamBackoff(
                attempt: attempt,
                initial: options.initialBackoff,
                maximum: options.maxBackoff
            )
            try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
        }
    }

    /// Runs one connection to exhaustion.
    private func runConnection(
        continuation: AsyncThrowingStream<WebhookRecord, Error>.Continuation,
        delivered: inout Int
    ) async throws {
        let configuration = URLSessionConfiguration.ephemeral
        let session = URLSession(configuration: configuration)
        let socket = session.webSocketTask(with: makeRequest())
        socket.resume()
        defer {
            socket.cancel(with: .goingAway, reason: nil)
            session.invalidateAndCancel()
        }

        while true {
            try Task.checkCancellation()

            let message: URLSessionWebSocketTask.Message
            do {
                message = try await socket.receive()
            } catch {
                if isPolicyViolation(socket: socket, error: error) {
                    throw webHookyStreamClosedByServer
                }
                // A normal close surfaces here as a receive failure; whether
                // that ends the stream or triggers a retry is the caller's
                // decision, made in `run`.
                if socket.closeCode == .normalClosure || socket.closeCode == .goingAway {
                    return
                }
                throw WebhookyError(
                    message: "stream read failed: \(error.localizedDescription)")
            }

            let raw: String
            switch message {
            case .string(let text):
                raw = text
            case .data(let data):
                raw = String(decoding: data, as: UTF8.self)
            @unknown default:
                continue
            }

            let frame = try decodeStreamFrame(raw)
            if frame.type == "ready" {
                options.onReady?()
                continue
            }
            guard let record = frame.record else { continue }

            continuation.yield(record)
            delivered += 1
            if let maximum = options.maxRecords, delivered >= maximum {
                return
            }
        }
    }

    private func isPolicyViolation(
        socket: URLSessionWebSocketTask,
        error: Error
    ) -> Bool {
        if socket.closeCode.rawValue == webHookyPolicyViolationCode {
            return true
        }
        // Some platforms surface the close code only through the error.
        let nsError = error as NSError
        return nsError.code == webHookyPolicyViolationCode
            && nsError.domain == NSURLErrorDomain
    }
}

extension URL {
    /// A placeholder used only when a stream URL fails to parse, which the
    /// request then reports as a transport failure rather than crashing.
    fileprivate init(fileURLToPath path: String) {
        self.init(fileURLWithPath: path)
    }
}
