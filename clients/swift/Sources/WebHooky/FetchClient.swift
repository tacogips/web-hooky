import Foundation

#if canImport(FoundationNetworking)
    import FoundationNetworking
#endif

/// Reads and streams records for a fetch API user.
///
/// Credentials are passed to the initializer, not read from the environment, so
/// one process can hold several clients with different identities.
///
/// ```swift
/// let client = try WebHookyFetchClient(
///     config: FetchClientConfig(
///         baseURL: "https://hooks.example.com",
///         apiKey: "...",
///         apiSecret: "..."
///     )
/// )
/// let records = try await client.records(
///     fetchUUID: uuid,
///     query: RecordQuery(onlyUnfetched: true)
/// )
/// ```
public final class WebHookyFetchClient: Sendable {
    let resolved: ResolvedConfig
    private let transport: Transport

    public init(config: FetchClientConfig, session: URLSession? = nil) throws {
        self.resolved = try ResolvedConfig.forFetch(config)
        self.transport = Transport(config: resolved, session: session)
    }

    /// The validated configuration, for diagnostics and stream URLs.
    public var configuration: ResolvedConfig { resolved }

    /// Builds the `_get` query string.
    ///
    /// Only parameters that differ from the server's own defaults are emitted,
    /// so a default query produces a bare URL.
    static func queryItems(for query: RecordQuery) -> [String: String] {
        var params: [String: String] = [:]
        if query.onlyUnfetched {
            params["only_unfetched"] = "true"
        }
        if query.markFetched == false {
            params["mark_fetched"] = "false"
        }
        if let from = query.from {
            params["from"] = from.queryValue
        }
        if let to = query.to {
            params["to"] = to.queryValue
        }
        if let limit = query.limit, limit > 0 {
            params["limit"] = String(limit)
        }
        return params
    }

    /// Reads stored records, newest first.
    ///
    /// Unless the query turns marking off, the server marks what it returns as
    /// fetched; each record's `fetched` field reflects the value from before
    /// that marking.
    public func records(
        fetchUUID: String,
        query: RecordQuery = RecordQuery()
    ) async throws -> [WebhookRecord] {
        let envelope = try await transport.decode(
            RecordsEnvelope.self,
            RequestSpec(
                method: "GET",
                path: "/_get/\(pathSegment(fetchUUID))",
                query: Self.queryItems(for: query)
            )
        )
        return envelope.records
    }

    /// Streams records over WebSocket.
    ///
    /// The stream ends when the server closes the socket, when `maxRecords` is
    /// reached, or when the task consuming it is cancelled.
    public func stream(
        fetchUUID: String,
        options: StreamOptions = StreamOptions()
    ) -> AsyncThrowingStream<WebhookRecord, Error> {
        RecordStream(config: resolved, fetchUUID: fetchUUID, options: options)
            .makeStream()
    }
}
