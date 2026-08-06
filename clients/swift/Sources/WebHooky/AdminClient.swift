import Foundation

#if canImport(FoundationNetworking)
    import FoundationNetworking
#endif

/// Typed access to every `/_admin/api` endpoint.
///
/// An admin API key grants every admin capability, including reading
/// destination fetch UUIDs, so treat a configured client as a full-privilege
/// handle.
public final class WebHookyAdminClient: Sendable {
    private static let base = "/_admin/api"

    let resolved: ResolvedConfig
    private let transport: Transport

    public init(config: AdminClientConfig, session: URLSession? = nil) throws {
        self.resolved = try ResolvedConfig.forAdmin(config)
        self.transport = Transport(config: resolved, session: session)
    }

    public var configuration: ResolvedConfig { resolved }

    private static func path(_ suffix: String) -> String {
        base + suffix
    }

    // -- identity --------------------------------------------------------

    /// The identity the server resolved for these credentials.
    public func me() async throws -> AdminIdentity {
        try await transport.decode(
            AdminIdentity.self,
            RequestSpec(method: "GET", path: Self.path("/me"))
        )
    }

    // -- destinations ----------------------------------------------------

    public func listDestinations() async throws -> [Destination] {
        try await transport.decode(
            DestinationsEnvelope.self,
            RequestSpec(method: "GET", path: Self.path("/destinations"))
        ).destinations
    }

    public func getDestination(id: String) async throws -> Destination {
        try await transport.decode(
            Destination.self,
            RequestSpec(
                method: "GET",
                path: Self.path("/destinations/\(pathSegment(id))")
            )
        )
    }

    /// Registers a destination.
    ///
    /// The result carries `inboundUuid` to hand to the vendor and `fetchUuid`
    /// for consumers.
    public func createDestination(
        _ input: CreateDestinationInput
    ) async throws -> Destination {
        try await transport.decode(
            Destination.self,
            RequestSpec(
                method: "POST",
                path: Self.path("/destinations"),
                body: try encodeBody(input)
            )
        )
    }

    /// Applies a partial update; fields left `nil` are untouched.
    public func updateDestination(
        id: String,
        _ input: UpdateDestinationInput
    ) async throws -> Destination {
        try await transport.decode(
            Destination.self,
            RequestSpec(
                method: "PATCH",
                path: Self.path("/destinations/\(pathSegment(id))"),
                body: try encodeBody(input)
            )
        )
    }

    /// Removes a destination and every record stored for it.
    public func deleteDestination(id: String) async throws {
        try await transport.discard(
            RequestSpec(
                method: "DELETE",
                path: Self.path("/destinations/\(pathSegment(id))")
            )
        )
    }

    /// Issues a new fetch UUID, invalidating the old read and stream URLs.
    public func rotateFetchUUID(id: String) async throws -> Destination {
        try await transport.decode(
            Destination.self,
            RequestSpec(
                method: "POST",
                path: Self.path("/destinations/\(pathSegment(id))/rotate-fetch-uuid")
            )
        )
    }

    /// Reads records for administration; never marks anything as fetched.
    public func listDestinationRecords(
        destinationID: String,
        limit: Int? = nil
    ) async throws -> [WebhookRecord] {
        var spec = RequestSpec(
            method: "GET",
            path: Self.path("/records/\(pathSegment(destinationID))")
        )
        if let limit, limit > 0 {
            spec.query["limit"] = String(limit)
        }
        return try await transport.decode(RecordsEnvelope.self, spec).records
    }

    // -- relays ----------------------------------------------------------

    public func listRelays(destinationID: String? = nil) async throws -> [Relay] {
        var spec = RequestSpec(method: "GET", path: Self.path("/relays"))
        if let destinationID, destinationID.isEmpty == false {
            spec.query["destinationId"] = destinationID
        }
        return try await transport.decode(RelaysEnvelope.self, spec).relays
    }

    public func getRelay(id: String) async throws -> Relay {
        try await transport.decode(
            Relay.self,
            RequestSpec(method: "GET", path: Self.path("/relays/\(pathSegment(id))"))
        )
    }

    public func createRelay(_ input: CreateRelayInput) async throws -> Relay {
        try await transport.decode(
            Relay.self,
            RequestSpec(
                method: "POST",
                path: Self.path("/relays"),
                body: try encodeBody(input)
            )
        )
    }

    /// A `secret` of `""` clears the signing secret; `nil` keeps the current one.
    public func updateRelay(id: String, _ input: UpdateRelayInput) async throws -> Relay {
        try await transport.decode(
            Relay.self,
            RequestSpec(
                method: "PATCH",
                path: Self.path("/relays/\(pathSegment(id))"),
                body: try encodeBody(input)
            )
        )
    }

    public func deleteRelay(id: String) async throws {
        try await transport.discard(
            RequestSpec(method: "DELETE", path: Self.path("/relays/\(pathSegment(id))"))
        )
    }

    public func listRelayDeliveries(
        id: String,
        limit: Int? = nil
    ) async throws -> RelayDeliveryPage {
        var spec = RequestSpec(
            method: "GET",
            path: Self.path("/relays/\(pathSegment(id))/deliveries")
        )
        if let limit, limit > 0 {
            spec.query["limit"] = String(limit)
        }
        return try await transport.decode(RelayDeliveryPage.self, spec)
    }

    /// Requeues this relay's failed deliveries; returns how many.
    public func retryRelay(id: String) async throws -> Int {
        try await transport.decode(
            RequeuedEnvelope.self,
            RequestSpec(
                method: "POST",
                path: Self.path("/relays/\(pathSegment(id))/retry")
            )
        ).requeued
    }

    // -- fetch API users -------------------------------------------------

    public func listApiUsers() async throws -> [ApiUser] {
        try await transport.decode(
            ApiUsersEnvelope.self,
            RequestSpec(method: "GET", path: Self.path("/users"))
        ).users
    }

    public func getApiUser(id: String) async throws -> ApiUser {
        try await transport.decode(
            ApiUser.self,
            RequestSpec(method: "GET", path: Self.path("/users/\(pathSegment(id))"))
        )
    }

    /// Mints a key/secret pair. The secret is returned here and nowhere else.
    public func createApiUser(label: String) async throws -> CreatedApiUser {
        try await transport.decode(
            CreatedApiUser.self,
            RequestSpec(
                method: "POST",
                path: Self.path("/users"),
                body: try encodeBody(["label": label])
            )
        )
    }

    public func rotateApiUserSecret(id: String) async throws -> CreatedApiUser {
        try await transport.decode(
            CreatedApiUser.self,
            RequestSpec(
                method: "POST",
                path: Self.path("/users/\(pathSegment(id))/rotate")
            )
        )
    }

    public func setApiUserEnabled(id: String, enabled: Bool) async throws -> ApiUser {
        try await transport.decode(
            ApiUser.self,
            RequestSpec(
                method: "PATCH",
                path: Self.path("/users/\(pathSegment(id))"),
                body: try encodeBody(["enabled": enabled])
            )
        )
    }

    public func deleteApiUser(id: String) async throws {
        try await transport.discard(
            RequestSpec(method: "DELETE", path: Self.path("/users/\(pathSegment(id))"))
        )
    }

    /// Authorizes a fetch API user to read a destination.
    public func grantDestination(
        userID: String,
        destinationID: String
    ) async throws -> ApiUser {
        try await transport.decode(
            ApiUser.self,
            RequestSpec(
                method: "PUT",
                path: Self.path(
                    "/users/\(pathSegment(userID))/grants/\(pathSegment(destinationID))"
                )
            )
        )
    }

    /// Withdraws a grant, closing the streams it authorized.
    public func revokeDestination(
        userID: String,
        destinationID: String
    ) async throws -> ApiUser {
        try await transport.decode(
            ApiUser.self,
            RequestSpec(
                method: "DELETE",
                path: Self.path(
                    "/users/\(pathSegment(userID))/grants/\(pathSegment(destinationID))"
                )
            )
        )
    }

    // -- addons ----------------------------------------------------------

    public func listAddons() async throws -> [Addon] {
        try await transport.decode(
            AddonsEnvelope.self,
            RequestSpec(method: "GET", path: Self.path("/addons"))
        ).addons
    }

    public func getAddon(name: String) async throws -> Addon {
        try await transport.decode(
            Addon.self,
            RequestSpec(method: "GET", path: Self.path("/addons/\(pathSegment(name))"))
        )
    }

    /// Installs an addon package (a zip archive with `addon.json` at its root).
    ///
    /// Uploaded addon code is imported into the server process and is therefore
    /// fully trusted. Deployments without a writable filesystem answer 501.
    public func uploadAddon(fileName: String, archive: Data) async throws -> Addon {
        let boundary = "webhookyaddonupload"
        let escaped =
            fileName
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")

        var body = Data()
        body.append(Data("--\(boundary)\r\n".utf8))
        body.append(
            Data(
                "content-disposition: form-data; name=\"package\"; "
                    .appending("filename=\"\(escaped)\"\r\n").utf8
            )
        )
        body.append(Data("content-type: application/zip\r\n\r\n".utf8))
        body.append(archive)
        body.append(Data("\r\n--\(boundary)--\r\n".utf8))

        // Multipart cannot use the JSON content type that satisfies the
        // server's CSRF rule, so this request carries a matching Origin.
        return try await transport.decode(
            Addon.self,
            RequestSpec(
                method: "POST",
                path: Self.path("/addons"),
                rawBody: body,
                contentType: "multipart/form-data; boundary=\(boundary)",
                sendOrigin: true
            )
        )
    }

    public func deleteAddon(name: String) async throws {
        try await transport.discard(
            RequestSpec(
                method: "DELETE",
                path: Self.path("/addons/\(pathSegment(name))")
            )
        )
    }

    // -- admin keys and admin users --------------------------------------

    public func listAdminKeys() async throws -> [AdminKey] {
        try await transport.decode(
            AdminKeysEnvelope.self,
            RequestSpec(method: "GET", path: Self.path("/admin-keys"))
        ).keys
    }

    /// Mints an admin API key; the secret is returned exactly once.
    public func createAdminKey(label: String) async throws -> CreatedAdminKey {
        try await transport.decode(
            CreatedAdminKey.self,
            RequestSpec(
                method: "POST",
                path: Self.path("/admin-keys"),
                body: try encodeBody(["label": label])
            )
        )
    }

    public func deleteAdminKey(id: String) async throws {
        try await transport.discard(
            RequestSpec(
                method: "DELETE",
                path: Self.path("/admin-keys/\(pathSegment(id))")
            )
        )
    }

    public func listAdminUsers() async throws -> [AdminUser] {
        try await transport.decode(
            AdminUsersEnvelope.self,
            RequestSpec(method: "GET", path: Self.path("/admin-users"))
        ).adminUsers
    }

    public func createAdminUser(subject: String) async throws -> AdminUser {
        try await transport.decode(
            AdminUser.self,
            RequestSpec(
                method: "POST",
                path: Self.path("/admin-users"),
                body: try encodeBody(["subject": subject])
            )
        )
    }

    public func deleteAdminUser(subject: String) async throws {
        try await transport.discard(
            RequestSpec(
                method: "DELETE",
                path: Self.path("/admin-users/\(pathSegment(subject))")
            )
        )
    }
}
