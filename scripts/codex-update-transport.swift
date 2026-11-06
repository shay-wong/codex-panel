import Foundation
import Darwin

// A small URLSession transport, not a caller of Codex's updater or its installation lifecycle.
func allowedURL(_ url: URL) -> Bool {
    guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
          components.user == nil, components.password == nil else { return false }
    let scheme = components.scheme?.lowercased()
    let host = components.host?.lowercased()
    #if CODEX_TRANSPORT_TESTING
    if scheme == "http" && host == "127.0.0.1" { return true }
    #endif
    return scheme == "https" && (components.port == nil || components.port == 443)
        && (host == "updates.oaistatic.com" || host == "persistent.oaistatic.com")
}

struct TransferError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

final class Download: NSObject, URLSessionDataDelegate {
    let url: URL
    let destination: String
    let expectedLength: Int64
    let offset: Int64
    let completed = DispatchSemaphore(value: 0)
    var failure: Error?
    private var file: FileHandle?
    private var downloaded: Int64 = 0
    private var responseTotal: Int64?
    private var redirects = 0
    private var lastProgress = ProcessInfo.processInfo.systemUptime

    init(url: URL, destination: String, expectedLength: Int64, offset: Int64) {
        self.url = url
        self.destination = destination
        self.expectedLength = expectedLength
        self.offset = offset
    }

    func request() -> URLRequest {
        var request = URLRequest(url: url)
        request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        if offset > 0 { request.setValue("bytes=\(offset)-", forHTTPHeaderField: "Range") }
        return request
    }

    private func reportProgress(force: Bool = false) {
        let now = ProcessInfo.processInfo.systemUptime
        guard force || now - lastProgress >= 0.2 else { return }
        lastProgress = now
        FileHandle.standardOutput.write(Data("{\"downloaded\":\(downloaded)}\n".utf8))
    }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        redirects += 1
        guard redirects <= 5, let redirected = request.url, allowedURL(redirected) else {
            failure = TransferError("Codex update redirected outside the official HTTPS hosts or too many times")
            completionHandler(nil)
            return
        }
        var next = request
        next.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        if offset > 0 { next.setValue("bytes=\(offset)-", forHTTPHeaderField: "Range") }
        completionHandler(next)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
                    didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        do {
            if let failure = failure { throw failure }
            guard let response = response as? HTTPURLResponse, let finalURL = response.url, allowedURL(finalURL) else {
                throw TransferError("Codex update response is not from an official HTTPS host")
            }
            var start: Int64 = 0
            var bodyLength: Int64?
            switch response.statusCode {
            case 200:
                if expectedLength > 0 { responseTotal = expectedLength; bodyLength = expectedLength }
            case 206:
                guard let range = response.value(forHTTPHeaderField: "Content-Range"), range.hasPrefix("bytes ") else {
                    throw TransferError("Codex update is missing its Content-Range")
                }
                let parts = range.dropFirst(6).split(separator: "/", omittingEmptySubsequences: false)
                let interval = parts.first?.split(separator: "-", omittingEmptySubsequences: false) ?? []
                guard parts.count == 2, interval.count == 2,
                      let first = Int64(interval[0]), let last = Int64(interval[1]), let total = Int64(parts[1]),
                      first == offset, first >= 0, total > first, last == total - 1,
                      expectedLength == 0 || expectedLength == total else {
                    throw TransferError("Codex update Content-Range does not match the requested bytes")
                }
                start = first
                responseTotal = total
                bodyLength = total - first
            default:
                throw TransferError("Codex update download failed: HTTP \(response.statusCode)")
            }
            if let contentLength = response.value(forHTTPHeaderField: "Content-Length") {
                guard let length = Int64(contentLength), length >= 0,
                      bodyLength == nil || bodyLength == length else {
                    throw TransferError("Codex update response length does not match the expected length")
                }
                if responseTotal == nil { responseTotal = length + start }
            }
            let descriptor = Darwin.open(destination, O_WRONLY | O_CREAT | O_NOFOLLOW, S_IRUSR | S_IWUSR)
            guard descriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
            let output = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
            do {
                if start == 0 { try output.truncate(atOffset: 0) }
                else {
                    let size = try output.seekToEnd()
                    guard size == UInt64(start) else { throw TransferError("Codex update partial file has changed") }
                }
                try output.seek(toOffset: UInt64(start))
            } catch {
                try? output.close()
                throw error
            }
            file = output
            downloaded = start
            reportProgress(force: true)
            completionHandler(.allow)
        } catch {
            failure = error
            completionHandler(.cancel)
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard failure == nil, let file = file else { return }
        do {
            let next = downloaded + Int64(data.count)
            if let total = responseTotal, next > total { throw TransferError("Codex update response exceeded the expected length") }
            try file.write(contentsOf: data)
            downloaded = next
            reportProgress()
        } catch {
            failure = error
            dataTask.cancel()
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if failure == nil { failure = error }
        if failure == nil, let total = responseTotal, downloaded != total {
            failure = TransferError("Codex update download is incomplete")
        }
        do { try file?.close() } catch { if failure == nil { failure = error } }
        file = nil
        if failure == nil { reportProgress(force: true) }
        completed.signal()
    }
}

do {
    let args = CommandLine.arguments
    guard (args.count == 4 || args.count == 5), let url = URL(string: args[1]), allowedURL(url),
          let length = Int64(args[3]), length >= 0,
          let offset = Int64(args.count == 5 ? args[4] : "0"), offset >= 0,
          length == 0 || offset < length else {
        throw TransferError("Usage: CodexTransport OFFICIAL_HTTPS_URL DEST EXPECTED_LENGTH [OFFSET]")
    }
    let transfer = Download(url: url, destination: args[2], expectedLength: length, offset: offset)
    let configuration = URLSessionConfiguration.default
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.timeoutIntervalForRequest = 60
    configuration.timeoutIntervalForResource = 30 * 60
    let delegateQueue = OperationQueue()
    delegateQueue.maxConcurrentOperationCount = 1
    let session = URLSession(configuration: configuration, delegate: transfer, delegateQueue: delegateQueue)
    session.dataTask(with: transfer.request()).resume()
    transfer.completed.wait()
    session.invalidateAndCancel()
    if let failure = transfer.failure { throw failure }
} catch {
    FileHandle.standardError.write(Data("\(error)\n".utf8))
    exit(1)
}
