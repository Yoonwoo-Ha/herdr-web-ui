import Foundation

enum ScopePath {
    static func clean(_ path: String) -> String? {
        if path.contains("\\") { return nil }
        let lower = path.lowercased()
        if lower.contains("%2f") || lower.contains("%5c") { return nil }
        guard let decoded = path.removingPercentEncoding, !decoded.contains("\\") else { return nil }
        let twice = decoded.lowercased()
        if twice.contains("%2e") || twice.contains("%2f") || twice.contains("%5c") { return nil }
        if decoded.split(separator: "/", omittingEmptySubsequences: false).contains(where: { $0 == "." || $0 == ".." }) { return nil }
        return path
    }

    static func within(_ path: String, scope: String) -> Bool {
        guard scope.hasPrefix("/"), scope.hasSuffix("/"), clean(scope) != nil, let path = clean(path) else { return false }
        return (path.hasSuffix("/") ? path : path + "/").hasPrefix(scope)
    }
}
