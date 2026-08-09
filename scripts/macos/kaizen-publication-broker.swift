import Darwin
import Foundation

private struct BrokerConfig: Decodable {
    let runtimeUid: UInt32
    let runtimeGid: UInt32
    let schedulerSocketPath: String
    let publicationSocketPath: String
    let scheduledLauncherExecutable: String
    let supervisorLauncherExecutable: String
    let nodeExecutable: String
    let cliPath: String
    let gitExecutable: String
    let tokenFile: String
    let privateDirectory: String
    let allowedRepositories: [String: String]
}

private struct ProcessIdentity: Equatable {
    let pid: pid_t
    let auditToken: [UInt32]
}

private struct Registration {
    let identity: ProcessIdentity
    let capability: String
}

private final class RegistrationStore: @unchecked Sendable {
    private var registrations: [pid_t: Registration] = [:]
    private var pending: [pid_t: String] = [:]
    private let lock = NSLock()

    func expect(pid: pid_t, capability: String) {
        lock.lock(); defer { lock.unlock() }
        pending[pid] = capability
    }

    func promote(identity: ProcessIdentity, capability: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard let expected = pending.removeValue(forKey: identity.pid), constantTimeEqual(expected, capability) else { return false }
        registrations[identity.pid] = Registration(identity: identity, capability: capability)
        return true
    }

    func remove(pid: pid_t) {
        lock.lock(); defer { lock.unlock() }
        pending.removeValue(forKey: pid)
        registrations.removeValue(forKey: pid)
    }

    func matches(_ identity: ProcessIdentity, capability: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard let registration = registrations[identity.pid] else { return false }
        return registration.identity == identity && constantTimeEqual(registration.capability, capability)
    }
}

private let maximumRequestBytes = 65_536
private let registrations = RegistrationStore()

private func testingConfigPath() -> String? {
    guard let value = ProcessInfo.processInfo.environment["KAIZEN_BROKER_TEST_CONFIG"],
          value.hasPrefix("/private/tmp/kaizen-broker-test-") || value.hasPrefix("/tmp/kaizen-broker-test-") else { return nil }
    return value
}

private func configuredPath() -> String {
    if let value = testingConfigPath() { return value }
    return CommandLine.arguments.count == 2
        ? CommandLine.arguments[1]
        : "/Library/Application Support/KaizenLoop/publication-broker.plist"
}

private func constantTimeEqual(_ lhs: String, _ rhs: String) -> Bool {
    let left = Array(lhs.utf8), right = Array(rhs.utf8)
    var difference = UInt8(left.count == right.count ? 0 : 1)
    for index in 0..<max(left.count, right.count) {
        difference |= (index < left.count ? left[index] : 0) ^ (index < right.count ? right[index] : 0)
    }
    return difference == 0
}

private func peerCredentials(_ descriptor: Int32) throws -> (uid_t, gid_t, pid_t) {
    var uid: uid_t = 0, gid: gid_t = 0, pid: pid_t = 0
    guard getpeereid(descriptor, &uid, &gid) == 0 else {
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }
    var length = socklen_t(MemoryLayout<pid_t>.size)
    guard getsockopt(descriptor, SOL_LOCAL, LOCAL_PEERPID, &pid, &length) == 0, pid > 0 else {
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }
    return (uid, gid, pid)
}

private func identity(_ descriptor: Int32, pid: pid_t) throws -> ProcessIdentity {
    var token = [UInt32](repeating: 0, count: 8)
    var length = socklen_t(token.count * MemoryLayout<UInt32>.size)
    let result = token.withUnsafeMutableBytes {
        getsockopt(descriptor, SOL_LOCAL, LOCAL_PEERTOKEN, $0.baseAddress, &length)
    }
    guard result == 0,
          length == token.count * MemoryLayout<UInt32>.size else {
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }
    return ProcessIdentity(pid: pid, auditToken: token)
}

private func readRequest(_ descriptor: Int32) throws -> [String: Any] {
    var timeout = timeval(tv_sec: 10, tv_usec: 0)
    _ = setsockopt(descriptor, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    var data = Data()
    var byte: UInt8 = 0
    while data.count <= maximumRequestBytes {
        let count = Darwin.read(descriptor, &byte, 1)
        if count <= 0 { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        if byte == 0x0a { break }
        data.append(byte)
    }
    guard data.count <= maximumRequestBytes,
          let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        throw NSError(domain: "KaizenPublicationBroker", code: 1)
    }
    return object
}

private func respond(_ descriptor: Int32, _ ok: Bool) {
    let data = Data(ok ? "{\"ok\":true}\n".utf8 : "{\"ok\":false}\n".utf8)
    _ = data.withUnsafeBytes { Darwin.write(descriptor, $0.baseAddress, data.count) }
    _ = shutdown(descriptor, SHUT_RDWR)
}

private func exactKeys(_ request: [String: Any], _ keys: Set<String>) -> Bool {
    Set(request.keys) == keys
}

private func connected(_ descriptor: Int32) -> Bool {
    let flags = fcntl(descriptor, F_GETFL)
    _ = fcntl(descriptor, F_SETFL, flags | O_NONBLOCK)
    var byte: UInt8 = 0
    let count = recv(descriptor, &byte, 1, MSG_PEEK)
    _ = fcntl(descriptor, F_SETFL, flags)
    if count == 0 { return false }
    return count > 0 || errno == EAGAIN || errno == EWOULDBLOCK
}

private func runProcess(
    executable: String,
    arguments: [String],
    environment: [String: String],
    cancelOnDisconnect descriptor: Int32?
) throws -> Process {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    process.environment = environment
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = FileHandle.standardError
    process.standardError = FileHandle.standardError
    try process.run()
    _ = setpgid(process.processIdentifier, process.processIdentifier)
    while process.isRunning {
        if let descriptor, !connected(descriptor) {
            _ = kill(-process.processIdentifier, SIGTERM)
            usleep(200_000)
            if process.isRunning { _ = kill(-process.processIdentifier, SIGKILL) }
            process.waitUntilExit()
            throw NSError(domain: "KaizenPublicationBroker", code: 2)
        }
        usleep(50_000)
    }
    return process
}

private func safeEnvironment(_ extra: [String: String] = [:]) -> [String: String] {
    var environment = [
        "HOME": "/var/empty",
        "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_TERMINAL_PROMPT": "0"
    ]
    for (key, value) in extra { environment[key] = value }
    if let value = testingConfigPath() {
        environment["KAIZEN_BROKER_TEST_CONFIG"] = value
    }
    return environment
}

private func trustedRootPath(_ candidate: String, regularFile: Bool = true, exactMode: mode_t? = nil) -> Bool {
    guard testingConfigPath() == nil else { return true }
    var first = stat()
    guard lstat(candidate, &first) == 0, (first.st_mode & S_IFMT) != S_IFLNK else { return false }
    let resolved = URL(fileURLWithPath: candidate).resolvingSymlinksInPath().path
    var current = resolved
    while true {
        var status = stat()
        guard stat(current, &status) == 0,
              status.st_uid == 0,
              status.st_mode & 0o022 == 0 else { return false }
        if current == resolved {
            if regularFile && (status.st_mode & S_IFMT) != S_IFREG { return false }
            if let exactMode, status.st_mode & 0o777 != exactMode { return false }
        }
        let parent = (current as NSString).deletingLastPathComponent
        if parent == current || current == "/" { return true }
        current = parent.isEmpty ? "/" : parent
    }
}

private func validateRootConfiguration(_ config: BrokerConfig, path: String) -> Bool {
    let testRoot = testingConfigPath().map { ($0 as NSString).deletingLastPathComponent }
    guard trustedRootPath(path, exactMode: 0o600),
          trustedRootPath(config.tokenFile, exactMode: 0o600),
          trustedRootPath(config.scheduledLauncherExecutable),
          trustedRootPath(config.supervisorLauncherExecutable),
          trustedRootPath(config.nodeExecutable),
          trustedRootPath(config.cliPath),
          trustedRootPath(config.gitExecutable),
          config.allowedRepositories.allSatisfy({ repository, url in
              repository.range(of: #"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$"#, options: .regularExpression) != nil &&
              (url == "https://github.com/\(repository).git" || (testRoot.map { url.hasPrefix("file://\($0)/") } ?? false))
          }),
          let tokenStatus = try? FileManager.default.attributesOfItem(atPath: config.tokenFile),
          ((tokenStatus[.size] as? NSNumber)?.intValue ?? 0) > 0 else { return false }
    return true
}

private func handleScheduledRun(_ descriptor: Int32, config: BrokerConfig, request: [String: Any]) throws -> Bool {
    guard exactKeys(request, ["version", "operation", "project", "job", "capability"]),
          request["version"] as? Int == 1,
          request["operation"] as? String == "scheduled-run",
          let project = request["project"] as? String,
          let job = request["job"] as? String,
          let capability = request["capability"] as? String,
          capability.range(of: #"^[a-f0-9]{64}$"#, options: .regularExpression) != nil,
          project.range(of: #"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$"#, options: .regularExpression) != nil,
          job.range(of: #"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$"#, options: .regularExpression) != nil else { return false }
    let (uid, _, _) = try peerCredentials(descriptor)
    guard uid == config.runtimeUid else { return false }

    let process = Process()
    process.executableURL = URL(fileURLWithPath: config.supervisorLauncherExecutable)
    process.arguments = ["run", capability, project, job]
    process.environment = safeEnvironment()
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = FileHandle.standardError
    process.standardError = FileHandle.standardError
    try process.run()
    _ = setpgid(process.processIdentifier, process.processIdentifier)
    registrations.expect(pid: process.processIdentifier, capability: capability)
    defer { registrations.remove(pid: process.processIdentifier) }
    while process.isRunning {
        if !connected(descriptor) {
            _ = kill(-process.processIdentifier, SIGTERM)
            usleep(200_000)
            if process.isRunning { _ = kill(-process.processIdentifier, SIGKILL) }
            process.waitUntilExit()
            return false
        }
        usleep(50_000)
    }
    return process.terminationReason == .exit && process.terminationStatus == 0
}

private func authenticateSupervisor(_ descriptor: Int32, config: BrokerConfig, capability: String) throws -> Bool {
    let (uid, _, pid) = try peerCredentials(descriptor)
    guard uid == config.runtimeUid else { return false }
    return registrations.matches(try identity(descriptor, pid: pid), capability: capability)
}

private func validateTreeAndTakeOwnership(_ root: String) throws {
    let manager = FileManager.default
    guard let enumerator = manager.enumerator(atPath: root) else { throw NSError(domain: "KaizenPublicationBroker", code: 3) }
    var paths = [root]
    while let relative = enumerator.nextObject() as? String { paths.append((root as NSString).appendingPathComponent(relative)) }
    for candidate in paths {
        var status = stat()
        guard lstat(candidate, &status) == 0,
              (status.st_mode & S_IFMT) != S_IFLNK,
              !((status.st_mode & S_IFMT) == S_IFREG && status.st_nlink != 1) else {
            throw NSError(domain: "KaizenPublicationBroker", code: 4)
        }
    }
    if testingConfigPath() != nil {
        let owner = getuid()
        let group = getgid()
        for candidate in paths.reversed() {
            guard chown(candidate, owner, group) == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
            var status = stat(); guard lstat(candidate, &status) == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
            _ = chmod(candidate, (status.st_mode & S_IFMT) == S_IFDIR ? 0o700 : 0o600)
        }
        return
    }
    let owner: uid_t = 0
    let group: gid_t = 0
    for candidate in paths.reversed() {
        guard chown(candidate, owner, group) == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        var status = stat(); guard lstat(candidate, &status) == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        _ = chmod(candidate, (status.st_mode & S_IFMT) == S_IFDIR ? 0o700 : 0o600)
    }
}

private func runGit(
    _ config: BrokerConfig,
    _ args: [String],
    cwd: String,
    descriptor: Int32? = nil,
    extraEnvironment: [String: String] = [:],
    allowedExitCodes: Set<Int32> = [0]
) throws -> String {
    let process = Process()
    let output = Pipe()
    process.executableURL = URL(fileURLWithPath: config.gitExecutable)
    process.arguments = ["-C", cwd] + args
    process.environment = safeEnvironment(extraEnvironment)
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = output
    process.standardError = FileHandle.standardError
    try process.run()
    _ = setpgid(process.processIdentifier, process.processIdentifier)
    while process.isRunning {
        if let descriptor, !connected(descriptor) {
            _ = kill(-process.processIdentifier, SIGTERM)
            usleep(200_000)
            if process.isRunning { _ = kill(-process.processIdentifier, SIGKILL) }
            process.waitUntilExit()
            throw NSError(domain: "KaizenPublicationBroker", code: 5)
        }
        usleep(50_000)
    }
    let data = output.fileHandleForReading.readDataToEndOfFile()
    guard process.terminationReason == .exit && allowedExitCodes.contains(process.terminationStatus) else {
        throw NSError(domain: "KaizenPublicationBroker", code: 6)
    }
    return String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
}

private func shellQuote(_ value: String) -> String { "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'" }

private func publish(_ descriptor: Int32, config: BrokerConfig, request: [String: Any]) throws -> Bool {
    let keys: Set<String> = ["version", "operation", "capability", "cwd", "pushUrl", "refspec", "expectedRepo", "expectedSha", "forceWithLease"]
    let requiredKeys = keys.subtracting(["forceWithLease"])
    guard Set(request.keys) == requiredKeys || Set(request.keys) == keys,
          request["version"] as? Int == 1,
          request["operation"] as? String == "git-push",
          let capability = request["capability"] as? String,
          try authenticateSupervisor(descriptor, config: config, capability: capability),
          let source = request["cwd"] as? String, source.hasPrefix("/"),
          let suppliedUrl = request["pushUrl"] as? String,
          let refspec = request["refspec"] as? String,
          let expectedRepo = request["expectedRepo"] as? String,
          let expectedSha = request["expectedSha"] as? String,
          expectedSha.range(of: #"^[0-9a-f]{40}$"#, options: .regularExpression) != nil,
          let canonicalUrl = config.allowedRepositories[expectedRepo],
          (canonicalUrl == "https://github.com/\(expectedRepo).git" ||
              (testingConfigPath().map { canonicalUrl.hasPrefix("file://\(($0 as NSString).deletingLastPathComponent)/") } ?? false)),
          suppliedUrl == canonicalUrl else { return false }
    let parts = refspec.split(separator: ":", omittingEmptySubsequences: false)
    guard parts.count == 2,
          String(parts[0]).range(of: #"^[A-Za-z0-9][A-Za-z0-9._/-]{0,240}$"#, options: .regularExpression) != nil,
          String(parts[1]) == "refs/heads/\(parts[0])",
          !refspec.contains(".."), !refspec.contains("//"), !refspec.contains("@{") else { return false }
    if let lease = request["forceWithLease"] as? String {
        let expected = "--force-with-lease=\(parts[1]):"
        guard lease.hasPrefix(expected),
              String(lease.dropFirst(expected.count)).range(of: #"^(|[0-9a-f]{40})$"#, options: .regularExpression) != nil else { return false }
    }

    let manager = FileManager.default
    let operationRoot = (config.privateDirectory as NSString).appendingPathComponent(UUID().uuidString)
    let imported = (operationRoot as NSString).appendingPathComponent("repository.git")
    try manager.createDirectory(atPath: operationRoot, withIntermediateDirectories: false, attributes: [
        .posixPermissions: 0o700, .ownerAccountID: config.runtimeUid, .groupOwnerAccountID: config.runtimeGid
    ])
    defer { try? manager.removeItem(atPath: operationRoot) }
    let importer = try runProcess(
        executable: config.supervisorLauncherExecutable,
        arguments: ["import", source, imported],
        environment: safeEnvironment(),
        cancelOnDisconnect: descriptor
    )
    guard importer.terminationStatus == 0 else { return false }
    try validateTreeAndTakeOwnership(operationRoot)
    try? manager.removeItem(atPath: (imported as NSString).appendingPathComponent("hooks"))
    try? manager.removeItem(atPath: (imported as NSString).appendingPathComponent("objects/info/alternates"))
    let configContents = "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = true\n[transfer]\n\tfsckObjects = true\n"
    try configContents.write(toFile: (imported as NSString).appendingPathComponent("config"), atomically: true, encoding: .utf8)
    try manager.createDirectory(atPath: (imported as NSString).appendingPathComponent("hooks"), withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    _ = try runGit(config, ["fsck", "--full", "--no-dangling"], cwd: imported, descriptor: descriptor)
    let resolvedSha = try runGit(config, ["rev-parse", "--verify", "\(parts[0])^{commit}"], cwd: imported, descriptor: descriptor)
    guard resolvedSha == expectedSha, connected(descriptor) else { return false }
    let lfsCandidates = try runGit(
        config,
        ["grep", "-I", "-l", "-e", "^version https://git-lfs.github.com/spec/v1$", String(parts[0]), "--"],
        cwd: imported,
        descriptor: descriptor,
        allowedExitCodes: [0, 1]
    )
    for candidate in lfsCandidates.split(separator: "\n").prefix(1_000) {
        let prefix = "\(parts[0]):"
        let value = String(candidate)
        let candidatePath = value.hasPrefix(prefix) ? String(value.dropFirst(prefix.count)) : value
        let contents = try runGit(config, ["show", "\(parts[0]):\(candidatePath)"], cwd: imported, descriptor: descriptor)
        if contents.range(
            of: #"^version https://git-lfs.github.com/spec/v1\noid sha256:[0-9a-f]{64}\nsize [0-9]+(?:\n|$)"#,
            options: .regularExpression
        ) != nil { return false }
    }

    let helper = "!f() { test \"$1\" = get || exit 0; printf '%s\\n' username=x-access-token; printf '%s\\n' password=\"$(/bin/cat \(shellQuote(config.tokenFile)))\"; }; f"
    let environment = [
        "GIT_ALLOW_PROTOCOL": testingConfigPath() == nil ? "https" : "file",
        "GIT_CONFIG_COUNT": "4",
        "GIT_CONFIG_KEY_0": "credential.helper",
        "GIT_CONFIG_VALUE_0": "",
        "GIT_CONFIG_KEY_1": "credential.helper",
        "GIT_CONFIG_VALUE_1": helper,
        "GIT_CONFIG_KEY_2": "core.hooksPath",
        "GIT_CONFIG_VALUE_2": "/dev/null",
        "GIT_CONFIG_KEY_3": "http.followRedirects",
        "GIT_CONFIG_VALUE_3": "false"
    ]
    var pushArguments = ["push", "--no-verify"]
    if let lease = request["forceWithLease"] as? String {
        let observed = try runGit(
            config,
            ["ls-remote", "--refs", canonicalUrl, String(parts[1])],
            cwd: imported,
            descriptor: descriptor,
            extraEnvironment: environment
        )
        let observedSha = observed.split(separator: "\t", maxSplits: 1).first.map(String.init) ?? ""
        guard lease == "--force-with-lease=\(parts[1]):\(observedSha)" else { return false }
        pushArguments.append(lease)
    }
    pushArguments += [canonicalUrl, refspec]
    _ = try runGit(config, pushArguments, cwd: imported, descriptor: descriptor, extraEnvironment: environment)
    return connected(descriptor)
}

private func handlePublication(_ descriptor: Int32, config: BrokerConfig, request: [String: Any]) throws -> Bool {
    guard request["version"] as? Int == 1,
          let operation = request["operation"] as? String,
          let capability = request["capability"] as? String else { return false }
    if operation == "supervisor-register" {
        guard exactKeys(request, ["version", "operation", "capability"]) else { return false }
        let (uid, _, pid) = try peerCredentials(descriptor)
        guard uid == config.runtimeUid else { return false }
        return registrations.promote(identity: try identity(descriptor, pid: pid), capability: capability)
    }
    if operation == "preflight" {
        guard exactKeys(request, ["version", "operation", "capability"]) else { return false }
        return try authenticateSupervisor(descriptor, config: config, capability: capability)
    }
    return try publish(descriptor, config: config, request: request)
}

private func makeSocket(_ path: String, uid: uid_t, gid: gid_t) throws -> Int32 {
    let manager = FileManager.default
    let directory = (path as NSString).deletingLastPathComponent
    try manager.createDirectory(atPath: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o755])
    if testingConfigPath() == nil {
        guard chown(directory, 0, 0) == 0, chmod(directory, 0o755) == 0 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }
    }
    try? manager.removeItem(atPath: path)
    let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
    guard descriptor >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
    var address = sockaddr_un(); address.sun_family = sa_family_t(AF_UNIX)
    withUnsafeMutableBytes(of: &address.sun_path) { bytes in
        bytes.initializeMemory(as: UInt8.self, repeating: 0)
        for (index, byte) in path.utf8.enumerated() { bytes[index] = byte }
    }
    let length = socklen_t(MemoryLayout<sa_family_t>.size + path.utf8.count + 1)
    let result = withUnsafePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(descriptor, $0, length) }
    }
    guard result == 0, listen(descriptor, 32) == 0 else {
        let code = errno; close(descriptor); throw NSError(domain: NSPOSIXErrorDomain, code: Int(code))
    }
    guard chown(path, uid, gid) == 0, chmod(path, 0o660) == 0 else {
        close(descriptor); throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }
    return descriptor
}

private func serve(_ listeningSocket: Int32, handler: @escaping @Sendable (Int32) -> Void) -> Never {
    while true {
        let descriptor = accept(listeningSocket, nil, nil)
        if descriptor < 0 { continue }
        DispatchQueue.global(qos: .utility).async {
            defer { close(descriptor) }
            handler(descriptor)
        }
    }
}

do {
    guard geteuid() == 0 || testingConfigPath() != nil else { throw NSError(domain: "KaizenPublicationBroker", code: 7) }
    let path = configuredPath()
    let config = try PropertyListDecoder().decode(BrokerConfig.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
    guard validateRootConfiguration(config, path: path) else { throw NSError(domain: "KaizenPublicationBroker", code: 8) }
    try FileManager.default.createDirectory(atPath: config.privateDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    if testingConfigPath() == nil {
        guard chown(config.privateDirectory, 0, 0) == 0, chmod(config.privateDirectory, 0o700) == 0 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }
    }
    let socketOwner: uid_t = testingConfigPath() == nil ? 0 : config.runtimeUid
    let schedulerSocket = try makeSocket(config.schedulerSocketPath, uid: socketOwner, gid: config.runtimeGid)
    let publicationSocket = try makeSocket(config.publicationSocketPath, uid: socketOwner, gid: config.runtimeGid)
    Thread.detachNewThread {
        serve(schedulerSocket) { descriptor in
            let ok = (try? handleScheduledRun(descriptor, config: config, request: readRequest(descriptor))) ?? false
            respond(descriptor, ok)
        }
    }
    serve(publicationSocket) { descriptor in
        let ok = (try? handlePublication(descriptor, config: config, request: readRequest(descriptor))) ?? false
        respond(descriptor, ok)
    }
} catch {
    FileHandle.standardError.write(Data("Kaizen publication broker failed to start.\n".utf8))
    exit(1)
}
