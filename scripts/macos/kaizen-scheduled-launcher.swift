import Darwin
import Foundation
import Security

private struct LauncherConfig: Decodable {
    let schedulerSocketPath: String
    let scheduledJobs: [ScheduledJobConfig]
}

private struct ScheduledJobConfig: Decodable {
    let project: String
    let job: String
    let toolPath: String
    let hour: Int
    let minute: Int
    let publicationTimeoutMs: Int
}

private struct ScheduledRunRequest: Encodable {
    let version = 1
    let operation = "scheduled-run"
    let project: String
    let job: String
    let capability: String
}

private func configPath() -> String {
    if let value = ProcessInfo.processInfo.environment["KAIZEN_BROKER_TEST_CONFIG"],
       value.hasPrefix("/private/tmp/kaizen-broker-test-") || value.hasPrefix("/tmp/kaizen-broker-test-") { return value }
    return "/Library/Application Support/KaizenLoop/publication-broker.plist"
}

private func connectUnixSocket(_ socketPath: String) throws -> Int32 {
    guard socketPath.utf8.count < MemoryLayout<sockaddr_un>.size - 2 else {
        throw NSError(domain: "KaizenScheduledLauncher", code: 1)
    }
    let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
    guard descriptor >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    withUnsafeMutableBytes(of: &address.sun_path) { bytes in
        bytes.initializeMemory(as: UInt8.self, repeating: 0)
        for (index, byte) in socketPath.utf8.enumerated() { bytes[index] = byte }
    }
    let length = socklen_t(MemoryLayout<sa_family_t>.size + socketPath.utf8.count + 1)
    let result = withUnsafePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(descriptor, $0, length) }
    }
    guard result == 0 else {
        let code = errno
        close(descriptor)
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(code))
    }
    return descriptor
}

private func exchange(_ descriptor: Int32, request: Data) throws -> Bool {
    var payload = request + Data([0x0a])
    try payload.withUnsafeMutableBytes { rawBuffer in
        var sent = 0
        while sent < rawBuffer.count {
            let count = Darwin.write(descriptor, rawBuffer.baseAddress!.advanced(by: sent), rawBuffer.count - sent)
            if count <= 0 { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
            sent += count
        }
    }
    var response = Data()
    var buffer = [UInt8](repeating: 0, count: 256)
    while response.count <= 4096 {
        let count = Darwin.read(descriptor, &buffer, buffer.count)
        if count < 0 { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        if count == 0 { break }
        response.append(buffer, count: count)
    }
    let object = try JSONSerialization.jsonObject(with: response) as? [String: Any]
    return object?.count == 1 && object?["ok"] as? Bool == true
}

private func sendScheduledRun(_ config: LauncherConfig, project: String, job: String) throws -> Bool {
    var random = [UInt8](repeating: 0, count: 32)
    let randomCount = random.count
    let randomStatus = random.withUnsafeMutableBytes {
        SecRandomCopyBytes(kSecRandomDefault, randomCount, $0.baseAddress!)
    }
    guard randomStatus == errSecSuccess else { throw NSError(domain: "KaizenScheduledLauncher", code: 2) }
    let capability = random.map { String(format: "%02x", $0) }.joined()
    let descriptor = try connectUnixSocket(config.schedulerSocketPath)
    defer { close(descriptor) }
    return try exchange(descriptor, request: JSONEncoder().encode(ScheduledRunRequest(
        project: project,
        job: job,
        capability: capability
    )))
}

do {
    let config = try PropertyListDecoder().decode(LauncherConfig.self, from: Data(contentsOf: URL(fileURLWithPath: configPath())))
    let isTest = ProcessInfo.processInfo.environment["KAIZEN_BROKER_TEST_CONFIG"] != nil
    if CommandLine.arguments.count == 2 && CommandLine.arguments[1] == "dispatch" && geteuid() == 0 {
        let now = Calendar.current.dateComponents([.hour, .minute], from: Date())
        let due = config.scheduledJobs.filter { $0.hour == now.hour && $0.minute == now.minute }
        guard !due.isEmpty else { throw NSError(domain: "KaizenScheduledLauncher", code: 3) }
        for entry in due {
            guard try sendScheduledRun(config, project: entry.project, job: entry.job) else {
                throw NSError(domain: "KaizenScheduledLauncher", code: 4)
            }
        }
        exit(0)
    }
    guard isTest, CommandLine.arguments.count == 4 else {
        throw NSError(domain: "KaizenScheduledLauncher", code: 5)
    }
    exit(try sendScheduledRun(config, project: CommandLine.arguments[2], job: CommandLine.arguments[3]) ? 0 : 1)
} catch {
    FileHandle.standardError.write(Data("Kaizen scheduled publication launcher failed.\n".utf8))
    exit(1)
}
