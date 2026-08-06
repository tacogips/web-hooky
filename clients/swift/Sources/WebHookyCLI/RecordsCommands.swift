import ArgumentParser
import Foundation
import WebHooky

/// `webhooky records ...`
struct RecordsCommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "records",
        abstract: "Read and stream a destination's records.",
        subcommands: [GetCommand.self, StreamCommand.self]
    )
}

extension RecordsCommand {
    /// `webhooky records get`
    struct GetCommand: AsyncParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "get",
            abstract: "Read stored records, newest first."
        )

        @OptionGroup var options: GlobalOptions

        @Option(name: .long, help: "Destination fetch uuid (\(Env.fetchUUID)).")
        var fetchUuid: String?

        @Flag(name: .long, help: "Return only records no reader has taken yet.")
        var onlyUnfetched = false

        @Flag(name: .long, help: "Leave the returned records unmarked.")
        var noMarkFetched = false

        @Option(name: .long, help: "Lower time bound: unix seconds or ISO-8601.")
        var from: String?

        @Option(name: .long, help: "Upper time bound: unix seconds or ISO-8601.")
        var to: String?

        @Option(name: .long, help: "Maximum records to return.")
        var limit: Int?

        func run() async throws {
            let uuid = try resolveFetchUUID(fetchUuid)
            let client = try options.fetchClient()
            let records = try await client.records(
                fetchUUID: uuid,
                query: RecordQuery(
                    onlyUnfetched: onlyUnfetched,
                    markFetched: noMarkFetched == false,
                    from: parseTimeBound(from),
                    to: parseTimeBound(to),
                    limit: limit
                )
            )
            try Output.emit(records, pretty: options.pretty)
        }
    }

    /// `webhooky records stream`
    struct StreamCommand: AsyncParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "stream",
            abstract:
                "Stream records as newline-delimited JSON until interrupted."
        )

        @OptionGroup var options: GlobalOptions

        @Option(name: .long, help: "Destination fetch uuid (\(Env.fetchUUID)).")
        var fetchUuid: String?

        @Flag(name: .long, help: "Reconnect with backoff after a transport failure.")
        var reconnect = false

        @Option(name: .long, help: "Stop after this many records.")
        var maxRecords: Int?

        @Flag(
            name: .long,
            help: "Send credentials as query parameters instead of a header."
        )
        var queryCredentials = false

        func run() async throws {
            let uuid = try resolveFetchUUID(fetchUuid)
            let client = try options.fetchClient()

            let stream = client.stream(
                fetchUUID: uuid,
                options: StreamOptions(
                    reconnect: reconnect,
                    queryCredentials: queryCredentials,
                    maxRecords: maxRecords,
                    // Progress goes to stderr so stdout stays a clean record
                    // stream.
                    onReady: { Output.note("webhooky: streaming \(uuid)") },
                    onReconnect: { attempt, cause in
                        Output.note(
                            "webhooky: reconnect attempt \(attempt) after: \(cause)"
                        )
                    }
                )
            )

            for try await record in stream {
                try Output.emitLine(record)
            }
        }
    }
}
