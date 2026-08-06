import Foundation
import WebHooky

/// JSON output helpers.
///
/// Output is JSON on stdout, always; diagnostics go to stderr, so a stream can
/// be piped into `jq` while progress stays readable.
enum Output {
    private static func encoder(pretty: Bool) -> JSONEncoder {
        let encoder = JSONEncoder()
        // Keys are always sorted. A webhook payload decodes into a Swift
        // dictionary, which has no inherent order, so without this two
        // identical calls can print byte-different JSON - which breaks diffing
        // output between runs and comparing it against another client.
        var formatting: JSONEncoder.OutputFormatting = [
            .withoutEscapingSlashes, .sortedKeys,
        ]
        if pretty {
            formatting.insert(.prettyPrinted)
        }
        encoder.outputFormatting = formatting
        return encoder
    }

    /// Writes one JSON document to stdout.
    static func emit<T: Encodable>(_ value: T, pretty: Bool) throws {
        let data = try encoder(pretty: pretty).encode(value)
        print(String(decoding: data, as: UTF8.self))
    }

    /// Writes one JSON document per line, flushed as it is produced, so a
    /// stream composes with `jq` and `head`.
    static func emitLine<T: Encodable>(_ value: T) throws {
        let data = try encoder(pretty: false).encode(value)
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
    }

    /// Writes a diagnostic to stderr.
    static func note(_ message: String) {
        FileHandle.standardError.write(Data((message + "\n").utf8))
    }
}

/// A `{"deleted": "<id>"}` acknowledgement for the delete commands, which the
/// server answers with an empty 204.
struct DeletedAck: Encodable {
    let deleted: String
}

/// A `{"requeued": n}` result for the relay retry command.
struct RequeuedAck: Encodable {
    let requeued: Int
}

/// Parses an inline JSON object or `@path/to/file.json`.
///
/// Shells make large inline JSON painful to quote, and addon configuration is
/// exactly the kind of thing that already lives in a file.
func parseJSONArgument(_ raw: String?, flag: String) throws -> AnyJSON? {
    guard let raw else { return nil }
    var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if text.hasPrefix("@") {
        let path = String(text.dropFirst())
        do {
            text = try String(contentsOfFile: path, encoding: .utf8)
                .trimmingCharacters(in: .whitespacesAndNewlines)
        } catch {
            throw CLIUsageError("failed to read \(path): \(error.localizedDescription)")
        }
    }
    guard let data = text.data(using: .utf8),
        let value = try? JSONDecoder().decode(AnyJSON.self, from: data)
    else {
        throw CLIUsageError("--\(flag) is not valid JSON")
    }
    guard value.objectValue != nil else {
        throw CLIUsageError("--\(flag) must be a JSON object")
    }
    return value
}

/// Parses a `--from`/`--to` bound in either form the server accepts.
func parseTimeBound(_ raw: String?) -> TimeBound? {
    guard let raw, raw.isEmpty == false else { return nil }
    if let seconds = Int(raw) {
        return .seconds(seconds)
    }
    // The server parses ISO-8601 itself, so the string is passed through rather
    // than reinterpreted by a second parser here.
    return .iso8601(raw)
}
