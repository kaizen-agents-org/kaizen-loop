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
    let githubCliExecutable: String
    let tokenFile: String
    let privateDirectory: String
    let allowedRepositories: [String: String]
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

private struct ProcessIdentity: Equatable {
    let pid: pid_t
    let auditToken: [UInt32]
}

private struct Registration {
    let identity: ProcessIdentity
    let capability: String
    let repository: String
}

private final class RegistrationStore: @unchecked Sendable {
    private var registrations: [pid_t: Registration] = [:]
    private var pending: [pid_t: (capability: String, repository: String)] = [:]
    private let lock = NSLock()

    func expect(pid: pid_t, capability: String, repository: String) {
        lock.lock(); defer { lock.unlock() }
        pending[pid] = (capability, repository)
    }

    func isExpected(pid: pid_t, capability: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard let expected = pending[pid] else { return false }
        return constantTimeEqual(expected.capability, capability)
    }

    func promote(identity: ProcessIdentity, capability: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard let expected = pending.removeValue(forKey: identity.pid), constantTimeEqual(expected.capability, capability) else { return false }
        registrations[identity.pid] = Registration(identity: identity, capability: capability, repository: expected.repository)
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

    func repository(_ identity: ProcessIdentity, capability: String) -> String? {
        lock.lock(); defer { lock.unlock() }
        guard let registration = registrations[identity.pid], registration.identity == identity,
              constantTimeEqual(registration.capability, capability) else { return nil }
        return registration.repository
    }
}

private let maximumRequestBytes = 1_048_576
private let maximumGitHubOutputBytes = 16 * 1_024 * 1_024
private let registrations = RegistrationStore()

private func testingConfigPath() -> String? {
    guard geteuid() != 0,
          let value = ProcessInfo.processInfo.environment["KAIZEN_BROKER_TEST_CONFIG"],
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

private func processPath(_ pid: pid_t) -> String? {
    var buffer = [CChar](repeating: 0, count: 4_096)
    let count = proc_pidpath(pid, &buffer, UInt32(buffer.count))
    guard count > 0 else { return nil }
    return String(cString: buffer)
}

private func parentPid(_ pid: pid_t) -> pid_t? {
    var info = proc_bsdinfo()
    let size = Int32(MemoryLayout<proc_bsdinfo>.size)
    guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size else { return nil }
    return pid_t(info.pbi_ppid)
}

private func authenticateScheduledTrigger(_ descriptor: Int32, config: BrokerConfig) throws -> Bool {
    let (uid, _, pid) = try peerCredentials(descriptor)
    let expectedUid: uid_t = testingConfigPath() == nil ? 0 : config.runtimeUid
    guard uid == expectedUid,
          processPath(pid) == config.scheduledLauncherExecutable else { return false }
    if testingConfigPath() != nil { return true }
    return parentPid(pid) == 1 && processPath(1) == "/sbin/launchd"
}

private func readRequest(_ descriptor: Int32) throws -> [String: Any] {
    let deadline = Date().addingTimeInterval(10)
    var data = Data()
    var byte: UInt8 = 0
    while data.count <= maximumRequestBytes {
        let remaining = deadline.timeIntervalSinceNow
        guard remaining > 0 else { throw NSError(domain: "KaizenPublicationBroker", code: 9) }
        var timeout = timeval(
            tv_sec: Int(remaining),
            tv_usec: Int32((remaining - floor(remaining)) * 1_000_000)
        )
        _ = setsockopt(descriptor, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
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

private func respondFailure(_ descriptor: Int32, _ message: String) {
    let data: Data
    if let encoded = try? JSONSerialization.data(withJSONObject: ["ok": false, "error": message]) {
        data = encoded + Data([0x0a])
    } else {
        data = Data("{\"ok\":false,\"error\":\"scheduler rejected the request\"}\n".utf8)
    }
    _ = data.withUnsafeBytes { Darwin.write(descriptor, $0.baseAddress, data.count) }
    _ = shutdown(descriptor, SHUT_RDWR)
}

private func writeAll(_ descriptor: Int32, _ data: Data) -> Bool {
    var offset = 0
    while offset < data.count {
        let count = data.withUnsafeBytes {
            Darwin.write(descriptor, $0.baseAddress!.advanced(by: offset), data.count - offset)
        }
        if count < 0 && errno == EINTR { continue }
        if count <= 0 { return false }
        offset += count
    }
    return true
}

private func exactKeys(_ request: [String: Any], _ keys: Set<String>) -> Bool {
    Set(request.keys) == keys
}

private func connected(_ descriptor: Int32) -> Bool {
    let flags = fcntl(descriptor, F_GETFL)
    _ = fcntl(descriptor, F_SETFL, flags | O_NONBLOCK)
    var byte: UInt8 = 0
    let count = recv(descriptor, &byte, 1, MSG_PEEK)
    let receiveError = errno
    _ = fcntl(descriptor, F_SETFL, flags)
    if count == 0 { return false }
    return count > 0 || receiveError == EAGAIN || receiveError == EWOULDBLOCK
}

private final class SpawnedProcess {
    let processIdentifier: pid_t
    private var waitStatus: Int32?

    init(processIdentifier: pid_t) { self.processIdentifier = processIdentifier }

    var isRunning: Bool {
        guard waitStatus == nil else { return false }
        var status: Int32 = 0
        while true {
            let result = waitpid(processIdentifier, &status, WNOHANG)
            if result == processIdentifier { waitStatus = status; return false }
            if result == 0 { return true }
            if result < 0 && errno == EINTR { continue }
            return false
        }
    }

    func waitUntilExit() {
        guard waitStatus == nil else { return }
        var status: Int32 = 0
        while true {
            let result = waitpid(processIdentifier, &status, 0)
            if result == processIdentifier { waitStatus = status; return }
            if result < 0 && errno == EINTR { continue }
            return
        }
    }

    var exitedNormally: Bool {
        waitUntilExit()
        return waitStatus.map { $0 & 0x7f == 0 } ?? false
    }

    var terminationStatus: Int32 {
        waitUntilExit()
        return waitStatus.map { ($0 >> 8) & 0xff } ?? -1
    }

    var terminationSignal: Int32 {
        waitUntilExit()
        return waitStatus.map { $0 & 0x7f } ?? 0
    }
}

private func withCStringArray<Result>(
    _ values: [String],
    _ body: (UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>) throws -> Result
) throws -> Result {
    guard values.allSatisfy({ !$0.contains("\0") }) else {
        throw NSError(domain: "KaizenPublicationBroker", code: 11)
    }
    let pointers = values.map { strdup($0) }
    guard pointers.allSatisfy({ $0 != nil }) else {
        pointers.forEach { free($0) }
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(ENOMEM))
    }
    defer { pointers.forEach { free($0) } }
    var terminated = pointers + [nil]
    return try terminated.withUnsafeMutableBufferPointer { buffer in
        try body(buffer.baseAddress!)
    }
}

private func spawnProcess(
    executable: String,
    arguments: [String],
    environment: [String: String],
    standardInput: Int32? = nil,
    standardOutput: Int32 = STDERR_FILENO,
    standardError: Int32 = STDERR_FILENO,
    workingDirectory: String? = nil
) throws -> SpawnedProcess {
    var actions: posix_spawn_file_actions_t?
    let actionsResult = posix_spawn_file_actions_init(&actions)
    guard actionsResult == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(actionsResult)) }
    defer { posix_spawn_file_actions_destroy(&actions) }
    var attributes: posix_spawnattr_t?
    let attributesResult = posix_spawnattr_init(&attributes)
    guard attributesResult == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(attributesResult)) }
    defer { posix_spawnattr_destroy(&attributes) }
    let nullDescriptor = open("/dev/null", O_RDONLY | O_CLOEXEC)
    guard nullDescriptor >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
    defer { close(nullDescriptor) }
    if let workingDirectory {
        let result = posix_spawn_file_actions_addchdir_np(&actions, workingDirectory)
        guard result == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(result)) }
    }
    for (source, destination) in [
        (standardInput ?? nullDescriptor, STDIN_FILENO),
        (standardOutput, STDOUT_FILENO),
        (standardError, STDERR_FILENO)
    ] {
        let result = posix_spawn_file_actions_adddup2(&actions, source, destination)
        guard result == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(result)) }
    }
    let flags = Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT)
    let flagsResult = posix_spawnattr_setflags(&attributes, flags)
    guard flagsResult == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(flagsResult)) }
    let groupResult = posix_spawnattr_setpgroup(&attributes, 0)
    guard groupResult == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(groupResult)) }
    var pid: pid_t = 0
    let environmentValues = environment.sorted(by: { $0.key < $1.key }).map { "\($0.key)=\($0.value)" }
    let result = try withCStringArray([executable] + arguments) { argv in
        try withCStringArray(environmentValues) { environmentPointers in
            posix_spawn(&pid, executable, &actions, &attributes, argv, environmentPointers)
        }
    }
    guard result == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(result)) }
    return SpawnedProcess(processIdentifier: pid)
}

private func signalProcessGroup(_ process: SpawnedProcess, _ signal: Int32) throws {
    if kill(-process.processIdentifier, signal) == 0 { return }
    let code = errno
    if code == ESRCH { return }
    throw NSError(domain: NSPOSIXErrorDomain, code: Int(code))
}

private func processGroupExists(_ process: SpawnedProcess) -> Bool {
    if kill(-process.processIdentifier, 0) == 0 { return true }
    return errno == EPERM
}

private func cancelProcessGroup(_ process: SpawnedProcess) throws {
    try signalProcessGroup(process, SIGTERM)
    usleep(200_000)
    if processGroupExists(process) { try signalProcessGroup(process, SIGKILL) }
    process.waitUntilExit()
}

private func runProcess(
    executable: String,
    arguments: [String],
    environment: [String: String],
    cancelOnDisconnect descriptor: Int32?
) throws -> SpawnedProcess {
    let process = try spawnProcess(executable: executable, arguments: arguments, environment: environment)
    while process.isRunning {
        if let descriptor, !connected(descriptor) {
            try cancelProcessGroup(process)
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

private func validatedToolPath(_ value: String?) -> String? {
    guard let value, !value.isEmpty, value.utf8.count <= 16_384,
          !value.contains("\0"), !value.contains("\n"), !value.contains("\r") else { return nil }
    let directories = value.split(separator: ":", omittingEmptySubsequences: false)
    guard directories.count <= 128,
          directories.allSatisfy({ !$0.isEmpty && $0.hasPrefix("/") && $0.utf8.count <= 4_096 }) else { return nil }
    return value
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
    let scheduledKeys = config.scheduledJobs.map { "\($0.project)/\($0.job)" }
    guard trustedRootPath(path, exactMode: 0o644),
          trustedRootPath(config.tokenFile, exactMode: 0o600),
          trustedRootPath(config.scheduledLauncherExecutable),
          trustedRootPath(config.supervisorLauncherExecutable),
          trustedRootPath(config.nodeExecutable),
          trustedRootPath(config.cliPath),
          trustedRootPath(config.gitExecutable),
          trustedRootPath(config.githubCliExecutable),
          Set(scheduledKeys).count == scheduledKeys.count,
          config.scheduledJobs.allSatisfy({ entry in
              entry.project.range(of: #"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$"#, options: .regularExpression) != nil &&
              config.allowedRepositories.keys.filter({ $0.replacingOccurrences(of: "/", with: "-") == entry.project }).count == 1 &&
              entry.job.range(of: #"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$"#, options: .regularExpression) != nil &&
              validatedToolPath(entry.toolPath) != nil &&
              (0...23).contains(entry.hour) && (0...59).contains(entry.minute) &&
              (10_000...3_600_000).contains(entry.publicationTimeoutMs)
          }),
          config.allowedRepositories.allSatisfy({ repository, url in
              repository.range(of: #"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$"#, options: .regularExpression) != nil &&
              (url == "https://github.com/\(repository).git" || (testRoot.map { url.hasPrefix("file://\($0)/") } ?? false))
          }),
          let tokenStatus = try? FileManager.default.attributesOfItem(atPath: config.tokenFile),
          ((tokenStatus[.size] as? NSNumber)?.intValue ?? 0) > 0 else { return false }
    return true
}

private func handleScheduledRun(_ descriptor: Int32, config: BrokerConfig, request: [String: Any]) throws -> String? {
    guard exactKeys(request, ["version", "operation", "project", "job", "capability"]),
          request["version"] as? Int == 1,
          request["operation"] as? String == "scheduled-run",
          let project = request["project"] as? String,
          let job = request["job"] as? String,
          let capability = request["capability"] as? String,
          capability.range(of: #"^[a-f0-9]{64}$"#, options: .regularExpression) != nil,
          project.range(of: #"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$"#, options: .regularExpression) != nil,
          job.range(of: #"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$"#, options: .regularExpression) != nil else { return "invalid scheduled run request" }
    guard let registeredJob = config.scheduledJobs.first(where: { $0.project == project && $0.job == job }) else {
        return "scheduled job is not configured: \(project)/\(job)"
    }
    guard try authenticateScheduledTrigger(descriptor, config: config) else { return "scheduled launcher authentication failed" }

    let process = try spawnProcess(
        executable: config.supervisorLauncherExecutable,
        arguments: ["run", capability, project, job, registeredJob.toolPath, String(registeredJob.publicationTimeoutMs)],
        environment: safeEnvironment()
    )
    let repositories = config.allowedRepositories.keys.filter { $0.replacingOccurrences(of: "/", with: "-") == project }
    guard repositories.count == 1, let repository = repositories.first else {
        try cancelProcessGroup(process)
        return "scheduled job repository mapping is invalid: \(project)"
    }
    registrations.expect(pid: process.processIdentifier, capability: capability, repository: repository)
    defer { registrations.remove(pid: process.processIdentifier) }
    while process.isRunning {
        if !connected(descriptor) {
            try cancelProcessGroup(process)
            return "scheduled run client disconnected"
        }
        usleep(50_000)
    }
    guard process.exitedNormally else { return "scheduled run terminated by signal" }
    guard process.terminationStatus == 0 else {
        return "scheduled run exited with status \(process.terminationStatus)"
    }
    return nil
}
private func authenticateSupervisor(_ descriptor: Int32, config: BrokerConfig, capability: String) throws -> Bool {
    let (uid, _, pid) = try peerCredentials(descriptor)
    guard uid == config.runtimeUid else { return false }
    let processIdentity = try identity(descriptor, pid: pid)
    return registrations.matches(processIdentity, capability: capability)
        || registrations.promote(identity: processIdentity, capability: capability)
}

private func authenticatedRepository(_ descriptor: Int32, config: BrokerConfig, capability: String) throws -> String? {
    let (uid, _, pid) = try peerCredentials(descriptor)
    guard uid == config.runtimeUid else { return nil }
    let processIdentity = try identity(descriptor, pid: pid)
    if registrations.matches(processIdentity, capability: capability) {
        return registrations.repository(processIdentity, capability: capability)
    }
    guard registrations.promote(identity: processIdentity, capability: capability) else { return nil }
    return registrations.repository(processIdentity, capability: capability)
}

private func validateTreeAndTakeOwnership(_ root: String) throws {
    let manager = FileManager.default
    let owner: uid_t = testingConfigPath() == nil ? 0 : getuid()
    let group: gid_t = testingConfigPath() == nil ? 0 : getgid()
    let rootDescriptor = open(root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    guard rootDescriptor >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
    defer { close(rootDescriptor) }
    var rootStatus = stat()
    guard fstat(rootDescriptor, &rootStatus) == 0,
          (rootStatus.st_mode & S_IFMT) == S_IFDIR,
          fchown(rootDescriptor, owner, group) == 0,
          fchmod(rootDescriptor, 0o700) == 0 else {
        throw NSError(domain: "KaizenPublicationBroker", code: 4)
    }
    guard let enumerator = manager.enumerator(atPath: root) else { throw NSError(domain: "KaizenPublicationBroker", code: 3) }
    while let relative = enumerator.nextObject() as? String {
        let candidate = (root as NSString).appendingPathComponent(relative)
        let descriptor = open(candidate, O_RDONLY | O_NOFOLLOW)
        guard descriptor >= 0 else { throw NSError(domain: "KaizenPublicationBroker", code: 4) }
        defer { close(descriptor) }
        var status = stat()
        guard fstat(descriptor, &status) == 0,
              ((status.st_mode & S_IFMT) == S_IFDIR || (status.st_mode & S_IFMT) == S_IFREG),
              !((status.st_mode & S_IFMT) == S_IFREG && status.st_nlink != 1),
              fchown(descriptor, owner, group) == 0,
              fchmod(descriptor, (status.st_mode & S_IFMT) == S_IFDIR ? 0o700 : 0o600) == 0 else {
            throw NSError(domain: "KaizenPublicationBroker", code: 4)
        }
    }
}

private func logBrokerError(_ context: String, _ error: Error) {
    FileHandle.standardError.write(Data("Kaizen publication broker \(context): \(error)\n".utf8))
}

private func runGit(
    _ config: BrokerConfig,
    _ args: [String],
    cwd: String,
    descriptor: Int32? = nil,
    extraEnvironment: [String: String] = [:],
    allowedExitCodes: Set<Int32> = [0]
) throws -> String {
    let outputPath = (config.privateDirectory as NSString).appendingPathComponent("git-output-\(UUID().uuidString)")
    guard FileManager.default.createFile(atPath: outputPath, contents: nil, attributes: [.posixPermissions: 0o600]) else {
        throw NSError(domain: "KaizenPublicationBroker", code: 6)
    }
    let output = try FileHandle(forWritingTo: URL(fileURLWithPath: outputPath))
    defer {
        output.closeFile()
        try? FileManager.default.removeItem(atPath: outputPath)
    }
    let process = try spawnProcess(
        executable: config.gitExecutable,
        arguments: ["-C", cwd] + args,
        environment: safeEnvironment(extraEnvironment),
        standardOutput: output.fileDescriptor
    )
    while process.isRunning {
        if let descriptor, !connected(descriptor) {
            try cancelProcessGroup(process)
            throw NSError(domain: "KaizenPublicationBroker", code: 5)
        }
        usleep(50_000)
    }
    output.closeFile()
    let data = try Data(contentsOf: URL(fileURLWithPath: outputPath))
    guard process.exitedNormally && allowedExitCodes.contains(process.terminationStatus) else {
        throw NSError(domain: "KaizenPublicationBroker", code: 6)
    }
    return String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
}

private struct GitHubCliResult {
    let exitCode: Int32
    let stdout: String
    let stderr: String
}

private func argumentsUseOnlyExpectedValue(_ arguments: [String], names: Set<String>, expected: String) -> Bool {
    for (index, argument) in arguments.enumerated() {
        if names.contains(argument) {
            guard index + 1 < arguments.count, arguments[index + 1] == expected else { return false }
        }
        for name in names where argument.hasPrefix("\(name)=") {
            guard String(argument.dropFirst(name.count + 1)) == expected else { return false }
        }
        if names.contains("-R"), argument.hasPrefix("-R"), argument.count > 2 {
            guard String(argument.dropFirst(2)) == expected else { return false }
        }
    }
    return true
}

private func apiEndpoint(_ arguments: [String]) -> String? {
    let valueOptions: Set<String> = ["--cache", "-F", "--field", "-f", "--raw-field", "-H", "--header", "--hostname", "--input", "--jq", "-X", "--method", "--template"]
    let flagOptions: Set<String> = ["--include", "-i", "--paginate", "--silent", "--slurp", "--verbose"]
    var index = 1
    while index < arguments.count {
        let argument = arguments[index]
        if valueOptions.contains(argument) { index += 2; continue }
        if flagOptions.contains(argument) { index += 1; continue }
        if valueOptions.contains(where: { argument.hasPrefix("\($0)=") }) { index += 1; continue }
        return argument
    }
    return nil
}

private func githubArgumentsAllowed(_ arguments: [String], repository: String) -> Bool {
    guard let command = arguments.first else { return false }
    guard argumentsUseOnlyExpectedValue(arguments, names: ["-R", "--repo"], expected: repository),
          argumentsUseOnlyExpectedValue(arguments, names: ["--hostname"], expected: "github.com") else { return false }

    let allowedSubcommands: [String: Set<String>] = [
        "auth": ["status"],
        "issue": ["close", "comment", "create", "edit", "list", "view"],
        "label": ["create"],
        "pr": ["checks", "create", "edit", "list", "ready", "view"],
        "repo": ["view"]
    ]
    if command != "api" {
        guard arguments.count >= 2, allowedSubcommands[command]?.contains(arguments[1]) == true else { return false }
        if ["issue", "pr"].contains(command),
           ["close", "comment", "edit", "ready", "view", "checks"].contains(arguments[1]),
           arguments.count >= 3,
           arguments[2].range(of: #"^[1-9][0-9]*$"#, options: .regularExpression) == nil {
            return false
        }
        if command == "repo", arguments.count >= 3, !arguments[2].hasPrefix("-") { return false }
        return true
    }

    guard let endpoint = apiEndpoint(arguments) else { return false }
    if endpoint == "user" { return true }
    if endpoint == "graphql" {
        guard let separator = repository.firstIndex(of: "/") else { return false }
        let owner = String(repository[..<separator])
        let name = String(repository[repository.index(after: separator)...])
        let fields = arguments.enumerated().compactMap { index, argument -> String? in
            guard ["-F", "--field", "-f", "--raw-field"].contains(argument), index + 1 < arguments.count else { return nil }
            return arguments[index + 1]
        }
        let owners = fields.filter { $0.hasPrefix("owner=") }
        let names = fields.filter { $0.hasPrefix("name=") }
        let queries = fields.filter { $0.hasPrefix("query=") }
        guard !owners.isEmpty, owners.allSatisfy({ $0 == "owner=\(owner)" }),
              !names.isEmpty, names.allSatisfy({ $0 == "name=\(name)" }),
              queries.count == 1, let query = queries.first else { return false }
        let compactQuery = query.filter { !$0.isWhitespace }
        return compactQuery.contains("repository(owner:$owner,name:$name)") &&
            compactQuery.components(separatedBy: "repository(").count == 2 &&
            !["search(", "organization(", "user(", "viewer{", "node(", "nodes("].contains(where: compactQuery.contains)
    }
    let lowercasedEndpoint = endpoint.lowercased()
    guard !endpoint.contains(".."), !endpoint.contains("\\"),
          !lowercasedEndpoint.contains("%2f"), !lowercasedEndpoint.contains("%5c") else { return false }
    return endpoint == "repos/{owner}/{repo}" || endpoint.hasPrefix("repos/{owner}/{repo}/") ||
        endpoint == "repos/\(repository)" || endpoint.hasPrefix("repos/\(repository)/")
}

private func handleGitHubCli(
    _ descriptor: Int32,
    config: BrokerConfig,
    request: [String: Any]
) throws -> GitHubCliResult? {
    guard exactKeys(request, ["version", "operation", "capability", "args", "cwd", "input", "timeoutMs", "maxOutputBytes"]),
          request["version"] as? Int == 1,
          request["operation"] as? String == "github-cli",
          let capability = request["capability"] as? String,
          let repository = try authenticatedRepository(descriptor, config: config, capability: capability),
          let arguments = request["args"] as? [String],
          githubArgumentsAllowed(arguments, repository: repository),
          !arguments.contains("--show-token"),
          arguments.count <= 256,
          arguments.allSatisfy({ $0.utf8.count <= 262_144 && !$0.contains("\0") }),
          arguments.reduce(0, { $0 + $1.utf8.count }) <= 524_288,
          let requestedCwd = request["cwd"] as? String,
          requestedCwd.hasPrefix("/"), requestedCwd.utf8.count <= 4_096,
          !requestedCwd.contains("\0"), !requestedCwd.contains("\n"), !requestedCwd.contains("\r"),
          let input = request["input"] as? String,
          input.utf8.count <= 524_288,
          let timeoutMs = request["timeoutMs"] as? Int,
          (1...3_600_000).contains(timeoutMs),
          let maxOutputBytes = request["maxOutputBytes"] as? Int,
          (1...maximumGitHubOutputBytes).contains(maxOutputBytes) else { return nil }

    let manager = FileManager.default
    let operationRoot = (config.privateDirectory as NSString).appendingPathComponent("github-cli-\(UUID().uuidString)")
    try manager.createDirectory(atPath: operationRoot, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    defer { try? manager.removeItem(atPath: operationRoot) }
    let inputPath = (operationRoot as NSString).appendingPathComponent("stdin")
    let stdoutPath = (operationRoot as NSString).appendingPathComponent("stdout")
    let stderrPath = (operationRoot as NSString).appendingPathComponent("stderr")
    try input.write(toFile: inputPath, atomically: false, encoding: .utf8)
    guard manager.createFile(atPath: stdoutPath, contents: nil, attributes: [.posixPermissions: 0o600]),
          manager.createFile(atPath: stderrPath, contents: nil, attributes: [.posixPermissions: 0o600]) else { return nil }
    let inputHandle = try FileHandle(forReadingFrom: URL(fileURLWithPath: inputPath))
    let stdoutHandle = try FileHandle(forWritingTo: URL(fileURLWithPath: stdoutPath))
    let stderrHandle = try FileHandle(forWritingTo: URL(fileURLWithPath: stderrPath))
    defer {
        inputHandle.closeFile()
        stdoutHandle.closeFile()
        stderrHandle.closeFile()
    }
    let tokenContents = try String(contentsOfFile: config.tokenFile, encoding: .utf8)
    let token = tokenContents.hasSuffix("\n") ? String(tokenContents.dropLast()) : tokenContents
    guard !token.isEmpty, token.utf8.count <= 1_024, !token.contains("\0"), !token.contains("\r"), !token.contains("\n") else { return nil }
    let process = try spawnProcess(
        executable: config.githubCliExecutable,
        arguments: arguments,
        environment: safeEnvironment([
            "GH_TOKEN": token,
            "GH_CONFIG_DIR": "/var/empty",
            "GH_PAGER": "cat",
            "GH_PROMPT_DISABLED": "1",
            "GH_REPO": repository
        ]),
        standardInput: inputHandle.fileDescriptor,
        standardOutput: stdoutHandle.fileDescriptor,
        standardError: stderrHandle.fileDescriptor,
        workingDirectory: "/var/empty"
    )
    let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1_000)
    while process.isRunning {
        let stdoutSize = ((try? manager.attributesOfItem(atPath: stdoutPath)[.size] as? NSNumber) ?? 0).intValue
        let stderrSize = ((try? manager.attributesOfItem(atPath: stderrPath)[.size] as? NSNumber) ?? 0).intValue
        if !connected(descriptor) || Date() >= deadline || stdoutSize + stderrSize > maxOutputBytes {
            try cancelProcessGroup(process)
            return nil
        }
        usleep(50_000)
    }
    stdoutHandle.synchronizeFile()
    stderrHandle.synchronizeFile()
    let stdoutData = try Data(contentsOf: URL(fileURLWithPath: stdoutPath))
    let stderrData = try Data(contentsOf: URL(fileURLWithPath: stderrPath))
    guard stdoutData.count + stderrData.count <= maxOutputBytes else { return nil }
    let exitCode = process.exitedNormally ? process.terminationStatus : min(255, 128 + max(1, process.terminationSignal))
    return GitHubCliResult(
        exitCode: exitCode,
        stdout: String(decoding: stdoutData, as: UTF8.self),
        stderr: String(decoding: stderrData, as: UTF8.self)
    )
}

private func respondGitHubCli(_ descriptor: Int32, _ result: GitHubCliResult?) {
    let object: [String: Any] = result.map {
        [
            "ok": true,
            "exitCode": Int($0.exitCode),
            "stdoutBase64": Data($0.stdout.utf8).base64EncodedString(),
            "stderrBase64": Data($0.stderr.utf8).base64EncodedString()
        ]
    } ?? ["ok": false, "error": "github-cli-refused"]
    guard var data = try? JSONSerialization.data(withJSONObject: object), data.count <= maximumGitHubOutputBytes * 2 + 8_192 else {
        respond(descriptor, false)
        return
    }
    data.append(0x0a)
    _ = writeAll(descriptor, data)
    _ = shutdown(descriptor, SHUT_RDWR)
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
    let candidateLines = lfsCandidates.split(separator: "\n")
    guard candidateLines.count <= 1_000 else { return false }
    for candidate in candidateLines {
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
        return registrations.isExpected(pid: pid, capability: capability)
    }
    if operation == "preflight" {
        guard exactKeys(request, ["version", "operation", "capability", "pushUrl", "expectedRepo"]),
              let pushUrl = request["pushUrl"] as? String,
              let expectedRepo = request["expectedRepo"] as? String,
              let configuredUrl = config.allowedRepositories[expectedRepo],
              configuredUrl == pushUrl,
              (configuredUrl == "https://github.com/\(expectedRepo).git" ||
                  (testingConfigPath().map { configuredUrl.hasPrefix("file://\(($0 as NSString).deletingLastPathComponent)/") } ?? false)) else {
            return false
        }
        return try authenticateSupervisor(descriptor, config: config, capability: capability)
    }
    return try publish(descriptor, config: config, request: request)
}

private func makeSocket(_ path: String, uid: uid_t, gid: gid_t, mode: mode_t) throws -> Int32 {
    guard path.utf8.count < MemoryLayout<sockaddr_un>.size - 2 else {
        throw NSError(domain: "KaizenPublicationBroker", code: 10)
    }
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
    guard chown(path, uid, gid) == 0, chmod(path, mode) == 0 else {
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
        guard chown(config.privateDirectory, 0, config.runtimeGid) == 0,
              chmod(config.privateDirectory, 0o710) == 0 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }
    }
    let schedulerOwner: uid_t = testingConfigPath() == nil ? 0 : config.runtimeUid
    let schedulerSocket = try makeSocket(config.schedulerSocketPath, uid: schedulerOwner, gid: config.runtimeGid, mode: 0o600)
    let publicationOwner: uid_t = testingConfigPath() == nil ? 0 : getuid()
    let publicationSocket = try makeSocket(config.publicationSocketPath, uid: publicationOwner, gid: config.runtimeGid, mode: 0o620)
    Thread.detachNewThread {
        serve(schedulerSocket) { descriptor in
            do {
                if let failure = try handleScheduledRun(descriptor, config: config, request: readRequest(descriptor)) {
                    respondFailure(descriptor, failure)
                } else {
                    respond(descriptor, true)
                }
            } catch {
                logBrokerError("rejected a scheduled request", error)
                respondFailure(descriptor, error.localizedDescription)
            }
        }
    }
    serve(publicationSocket) { descriptor in
        do {
            let request = try readRequest(descriptor)
            if request["operation"] as? String == "github-cli" {
                respondGitHubCli(descriptor, try handleGitHubCli(descriptor, config: config, request: request))
            } else {
                respond(descriptor, try handlePublication(descriptor, config: config, request: request))
            }
        } catch {
            logBrokerError("rejected a publication request", error)
            respond(descriptor, false)
        }
    }
} catch {
    logBrokerError("failed to start", error)
    exit(1)
}
