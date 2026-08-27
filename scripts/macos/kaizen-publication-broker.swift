import Darwin
import Foundation
import Security

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
    let tokenFile: String?
    let githubAppId: UInt64?
    let githubAppInstallationId: UInt64?
    let githubAppPrivateKeyFile: String?
    let githubAppApiBaseUrl: String?
    let githubAppInstallations: [String: GitHubAppInstallationConfig]?
    let privateDirectory: String
    let allowedRepositories: [String: String]
    let scheduledJobs: [ScheduledJobConfig]
}

private struct GitHubAppInstallationConfig: Decodable {
    let appId: UInt64
    let installationId: UInt64
    let privateKeyFile: String
    let apiBaseUrl: String?
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

private struct GitHubInstallationCredential {
    let token: String
    let expiresAt: Date
}

private final class GitHubCredentialProvider: @unchecked Sendable {
    private let lock = NSLock()
    private var cached: [String: GitHubInstallationCredential] = [:]

    func token(for config: BrokerConfig, repository: String, forceRefresh: Bool = false) throws -> String {
        if let tokenFile = config.tokenFile {
            guard let token = readTrustedToken(tokenFile) else {
                throw NSError(domain: "KaizenPublicationBroker", code: 20)
            }
            return token
        }
        let installation = try githubAppInstallation(config, repository: repository)
        let apiBaseUrl = installation.apiBaseUrl ?? "https://api.github.com"
        let cacheKey = "\(installation.appId):\(installation.installationId):\(installation.privateKeyFile):\(apiBaseUrl)"
        lock.lock(); defer { lock.unlock() }
        if !forceRefresh, let cached = cached[cacheKey], cached.expiresAt.timeIntervalSinceNow > 300 { return cached.token }
        let credential = try mintGitHubInstallationCredential(installation)
        cached[cacheKey] = credential
        return credential.token
    }
}

private let githubCredentials = GitHubCredentialProvider()

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

private func authenticateOperatorCanary(_ descriptor: Int32, config: BrokerConfig) throws -> Bool {
    let (uid, _, pid) = try peerCredentials(descriptor)
    let expectedUid: uid_t = testingConfigPath() == nil ? 0 : config.runtimeUid
    return uid == expectedUid && processPath(pid) == config.scheduledLauncherExecutable
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

private func hasExtendedAcl(_ path: String) -> Bool {
    let process = Process()
    let output = Pipe()
    process.executableURL = URL(fileURLWithPath: "/bin/ls")
    process.arguments = ["-lde", path]
    process.standardOutput = output
    process.standardError = Pipe()
    do {
        try process.run()
        process.waitUntilExit()
    } catch {
        return true
    }
    guard process.terminationStatus == 0,
          let listing = String(data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) else {
        return true
    }
    return listing.split(separator: "\n").dropFirst().contains {
        $0.range(of: #"^\s*\d+:"#, options: .regularExpression) != nil
    }
}

private func assertRealDirectory(_ path: String) throws {
    var status = stat()
    guard lstat(path, &status) == 0 else {
        guard errno == ENOENT else {
            throw NSError(domain: "KaizenPublicationBroker", code: 13)
        }
        return
    }
    guard status.st_mode & S_IFMT == S_IFDIR else {
        throw NSError(domain: "KaizenPublicationBroker", code: 13)
    }
}

private func readTrustedToken(_ path: String) -> String? {
    let descriptor = open(path, O_RDONLY | O_NOFOLLOW)
    guard descriptor >= 0 else { return nil }
    defer { close(descriptor) }
    var status = stat()
    let expectedOwner: uid_t = testingConfigPath() == nil ? 0 : getuid()
    guard fstat(descriptor, &status) == 0,
          (status.st_mode & S_IFMT) == S_IFREG,
          status.st_nlink == 1,
          status.st_uid == expectedOwner,
          status.st_mode & 0o777 == 0o600,
          status.st_size > 0,
          status.st_size <= 1_025 else { return nil }
    let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: false)
    guard let data = try? handle.readToEnd(), data.count <= 1_025 else { return nil }
    let contents = String(decoding: data, as: UTF8.self)
    let token = contents.hasSuffix("\n") ? String(contents.dropLast()) : contents
    guard !token.isEmpty, token.utf8.count <= 1_024,
          !token.contains("\0"), !token.contains("\r"), !token.contains("\n") else { return nil }
    return token
}

private func readTrustedPrivateKey(_ path: String) -> Data? {
    let descriptor = open(path, O_RDONLY | O_NOFOLLOW)
    guard descriptor >= 0 else { return nil }
    defer { close(descriptor) }
    var status = stat()
    let expectedOwner: uid_t = testingConfigPath() == nil ? 0 : getuid()
    guard fstat(descriptor, &status) == 0,
          (status.st_mode & S_IFMT) == S_IFREG,
          status.st_nlink == 1,
          status.st_uid == expectedOwner,
          status.st_mode & 0o777 == 0o600,
          status.st_size > 0,
          status.st_size <= 65_536 else { return nil }
    let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: false)
    guard let data = try? handle.readToEnd(), !data.isEmpty, data.count <= 65_536 else { return nil }
    return data
}

private func readDERElement(_ data: Data, offset: inout Int, limit: Int) -> (tag: UInt8, content: Range<Int>)? {
    guard offset + 2 <= limit else { return nil }
    let tag = data[offset]
    offset += 1
    let firstLength = Int(data[offset])
    offset += 1
    let length: Int
    if firstLength & 0x80 == 0 {
        length = firstLength
    } else {
        let byteCount = firstLength & 0x7f
        guard (1...3).contains(byteCount), offset + byteCount <= limit, data[offset] != 0 else { return nil }
        var accumulated = 0
        for _ in 0..<byteCount {
            accumulated = accumulated << 8 | Int(data[offset])
            offset += 1
        }
        guard accumulated >= 128 else { return nil }
        length = accumulated
    }
    guard length >= 0, offset <= limit - length else { return nil }
    let content = offset..<(offset + length)
    offset += length
    return (tag, content)
}

private func pkcs1KeyData(fromPKCS8 data: Data) -> Data? {
    var rootOffset = 0
    guard let root = readDERElement(data, offset: &rootOffset, limit: data.count),
          root.tag == 0x30, rootOffset == data.count else { return nil }
    var childOffset = root.content.lowerBound
    guard let version = readDERElement(data, offset: &childOffset, limit: root.content.upperBound), version.tag == 0x02,
          let algorithm = readDERElement(data, offset: &childOffset, limit: root.content.upperBound), algorithm.tag == 0x30,
          let privateKey = readDERElement(data, offset: &childOffset, limit: root.content.upperBound), privateKey.tag == 0x04,
          !privateKey.content.isEmpty else { return nil }
    return Data(data[privateKey.content])
}

private func importGitHubAppPrivateKey(_ data: Data) -> SecKey? {
    guard let pem = String(data: data, encoding: .utf8) else { return nil }
    let lines = pem.components(separatedBy: .newlines).filter { !$0.isEmpty }
    guard let first = lines.first, let last = lines.last, lines.count >= 3 else { return nil }
    let isPKCS1 = first == "-----BEGIN RSA PRIVATE KEY-----" && last == "-----END RSA PRIVATE KEY-----"
    let isPKCS8 = first == "-----BEGIN PRIVATE KEY-----" && last == "-----END PRIVATE KEY-----"
    guard isPKCS1 || isPKCS8 else { return nil }
    let body = lines.dropFirst().dropLast().joined()
    guard body.range(of: #"^[A-Za-z0-9+/]+={0,2}$"#, options: .regularExpression) != nil,
          let decoded = Data(base64Encoded: body), !decoded.isEmpty else { return nil }
    let keyData = isPKCS8 ? pkcs1KeyData(fromPKCS8: decoded) : decoded
    guard let keyData else { return nil }
    var error: Unmanaged<CFError>?
    guard let key = SecKeyCreateWithData(keyData as CFData, [
        kSecAttrKeyType: kSecAttrKeyTypeRSA,
        kSecAttrKeyClass: kSecAttrKeyClassPrivate
    ] as CFDictionary, &error),
          let attributes = SecKeyCopyAttributes(key) as? [CFString: Any],
          let keySize = attributes[kSecAttrKeySizeInBits] as? Int,
          keySize >= 2_048 else { return nil }
    return key
}

private func base64Url(_ data: Data) -> String {
    data.base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}

private func githubAppJWT(appId: UInt64, privateKey: SecKey, now: Date = Date()) throws -> String {
    let header = try JSONSerialization.data(withJSONObject: ["alg": "RS256", "typ": "JWT"], options: [.sortedKeys])
    let timestamp = Int(now.timeIntervalSince1970)
    let payload = try JSONSerialization.data(withJSONObject: [
        "iat": timestamp - 60,
        "exp": timestamp + 540,
        "iss": appId
    ], options: [.sortedKeys])
    let signingInput = "\(base64Url(header)).\(base64Url(payload))"
    var signingError: Unmanaged<CFError>?
    guard let signature = SecKeyCreateSignature(
        privateKey,
        .rsaSignatureMessagePKCS1v15SHA256,
        Data(signingInput.utf8) as CFData,
        &signingError
    ) as Data? else {
        throw signingError?.takeRetainedValue() ?? NSError(domain: "KaizenPublicationBroker", code: 21)
    }
    return "\(signingInput).\(base64Url(signature))"
}

private final class GitHubTokenRequestDelegate: NSObject, URLSessionDataDelegate, URLSessionTaskDelegate, @unchecked Sendable {
    let semaphore = DispatchSemaphore(value: 0)
    private(set) var data = Data()
    private(set) var response: HTTPURLResponse?
    private(set) var error: Error?

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }

    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        self.response = response as? HTTPURLResponse
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive incoming: Data) {
        guard data.count <= 65_536 - incoming.count else {
            error = NSError(domain: "KaizenPublicationBroker", code: 26)
            dataTask.cancel()
            return
        }
        data.append(incoming)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if self.error == nil { self.error = error }
        semaphore.signal()
    }
}

private func parseGitHubTimestamp(_ value: String) -> Date? {
    let formatter = ISO8601DateFormatter()
    if let date = formatter.date(from: value) { return date }
    formatter.formatOptions.insert(.withFractionalSeconds)
    return formatter.date(from: value)
}

private func githubAppInstallation(_ config: BrokerConfig, repository: String) throws -> GitHubAppInstallationConfig {
    if let separator = repository.firstIndex(of: "/"),
       let installation = config.githubAppInstallations?[String(repository[..<separator])] {
        return installation
    }
    guard let appId = config.githubAppId,
          let installationId = config.githubAppInstallationId,
          let privateKeyFile = config.githubAppPrivateKeyFile else {
        throw NSError(domain: "KaizenPublicationBroker", code: 22)
    }
    return GitHubAppInstallationConfig(
        appId: appId,
        installationId: installationId,
        privateKeyFile: privateKeyFile,
        apiBaseUrl: config.githubAppApiBaseUrl
    )
}

private func mintGitHubInstallationCredential(_ installation: GitHubAppInstallationConfig) throws -> GitHubInstallationCredential {
    guard let privateKeyData = readTrustedPrivateKey(installation.privateKeyFile),
          let privateKey = importGitHubAppPrivateKey(privateKeyData) else {
        throw NSError(domain: "KaizenPublicationBroker", code: 22)
    }
    let jwt = try githubAppJWT(appId: installation.appId, privateKey: privateKey)
    let baseUrl = installation.apiBaseUrl ?? "https://api.github.com"
    guard let url = URL(string: "\(baseUrl)/app/installations/\(installation.installationId)/access_tokens") else {
        throw NSError(domain: "KaizenPublicationBroker", code: 23)
    }
    var request = URLRequest(url: url, timeoutInterval: 30)
    request.httpMethod = "POST"
    request.httpBody = Data("{}".utf8)
    request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
    request.setValue("Bearer \(jwt)", forHTTPHeaderField: "Authorization")
    request.setValue("2022-11-28", forHTTPHeaderField: "X-GitHub-Api-Version")
    request.setValue("kaizen-publication-broker", forHTTPHeaderField: "User-Agent")
    let delegate = GitHubTokenRequestDelegate()
    let sessionConfiguration = URLSessionConfiguration.ephemeral
    sessionConfiguration.timeoutIntervalForRequest = 30
    sessionConfiguration.timeoutIntervalForResource = 35
    sessionConfiguration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
    sessionConfiguration.urlCache = nil
    sessionConfiguration.httpCookieStorage = nil
    sessionConfiguration.httpShouldSetCookies = false
    let delegateQueue = OperationQueue()
    delegateQueue.maxConcurrentOperationCount = 1
    let session = URLSession(configuration: sessionConfiguration, delegate: delegate, delegateQueue: delegateQueue)
    session.dataTask(with: request).resume()
    guard delegate.semaphore.wait(timeout: .now() + 40) == .success else {
        session.invalidateAndCancel()
        throw NSError(domain: "KaizenPublicationBroker", code: 24)
    }
    session.finishTasksAndInvalidate()
    if let error = delegate.error { throw error }
    guard let response = delegate.response,
          response.statusCode == 201,
          delegate.data.count <= 65_536,
          let object = try JSONSerialization.jsonObject(with: delegate.data) as? [String: Any],
          let token = object["token"] as? String,
          !token.isEmpty, token.utf8.count <= 4_096,
          !token.contains("\0"), !token.contains("\r"), !token.contains("\n"),
          let expiresAtValue = object["expires_at"] as? String,
          let expiresAt = parseGitHubTimestamp(expiresAtValue),
          expiresAt.timeIntervalSinceNow > 60,
          expiresAt.timeIntervalSinceNow <= 7_200 else {
        throw NSError(domain: "KaizenPublicationBroker", code: 25)
    }
    return GitHubInstallationCredential(token: token, expiresAt: expiresAt)
}

private func validateRootConfiguration(_ config: BrokerConfig, path: String) -> Bool {
    let testRoot = testingConfigPath().map { ($0 as NSString).deletingLastPathComponent }
    let scheduledKeys = config.scheduledJobs.map { "\($0.project)/\($0.job)" }
    let configuredOwners = Set(config.allowedRepositories.keys.compactMap { $0.split(separator: "/", maxSplits: 1).first.map(String.init) })
    let hasStaticToken = config.tokenFile != nil && config.githubAppId == nil &&
        config.githubAppInstallationId == nil && config.githubAppPrivateKeyFile == nil && config.githubAppApiBaseUrl == nil &&
        config.githubAppInstallations == nil
    let hasGitHubApp = config.tokenFile == nil && (config.githubAppId ?? 0) > 0 &&
        (config.githubAppInstallationId ?? 0) > 0 && config.githubAppPrivateKeyFile != nil &&
        config.githubAppInstallations == nil && configuredOwners.count == 1
    let hasOwnerGitHubApps = config.tokenFile == nil && config.githubAppId == nil &&
        config.githubAppInstallationId == nil && config.githubAppPrivateKeyFile == nil && config.githubAppApiBaseUrl == nil &&
        !(config.githubAppInstallations?.isEmpty ?? true)
    let tokenValid = config.tokenFile.map { trustedRootPath($0, exactMode: 0o600) && readTrustedToken($0) != nil } ?? false
    let appKeyValid = config.githubAppPrivateKeyFile.map {
        trustedRootPath($0, exactMode: 0o600) && readTrustedPrivateKey($0).flatMap(importGitHubAppPrivateKey) != nil
    } ?? false
    let apiBaseValid = config.githubAppApiBaseUrl == nil || config.githubAppApiBaseUrl == "https://api.github.com" ||
        (testRoot != nil && config.githubAppApiBaseUrl?.range(of: #"^http://127\.0\.0\.1:[1-9][0-9]{0,4}$"#, options: .regularExpression) != nil)
    let ownerAppsValid = config.githubAppInstallations.map { installations in
        Set(installations.keys) == configuredOwners && installations.allSatisfy { owner, installation in
            owner.range(of: #"^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?$"#, options: .regularExpression) != nil &&
            installation.appId > 0 && installation.installationId > 0 &&
            trustedRootPath(installation.privateKeyFile, exactMode: 0o600) &&
            readTrustedPrivateKey(installation.privateKeyFile).flatMap(importGitHubAppPrivateKey) != nil &&
            (installation.apiBaseUrl == nil || installation.apiBaseUrl == "https://api.github.com" ||
                (testRoot != nil && installation.apiBaseUrl?.range(of: #"^http://127\.0\.0\.1:[1-9][0-9]{0,4}$"#, options: .regularExpression) != nil))
        }
    } ?? false
    guard trustedRootPath(path, exactMode: 0o644),
          ((hasStaticToken && tokenValid) || (hasGitHubApp && appKeyValid) || (hasOwnerGitHubApps && ownerAppsValid)),
          apiBaseValid,
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
          }) else { return false }
    return true
}

private func handleScheduledRun(_ descriptor: Int32, config: BrokerConfig, request: [String: Any]) throws -> String? {
    guard exactKeys(request, ["version", "operation", "project", "job", "capability"]),
          request["version"] as? Int == 1,
          let operation = request["operation"] as? String,
          operation == "scheduled-run" || operation == "scheduled-canary",
          let project = request["project"] as? String,
          let job = request["job"] as? String,
          let capability = request["capability"] as? String,
          capability.range(of: #"^[a-f0-9]{64}$"#, options: .regularExpression) != nil,
          project.range(of: #"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$"#, options: .regularExpression) != nil,
          job.range(of: #"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$"#, options: .regularExpression) != nil else { return "invalid scheduled run request" }
    guard let registeredJob = config.scheduledJobs.first(where: { $0.project == project && $0.job == job }) else {
        return "scheduled job is not configured: \(project)/\(job)"
    }
    let authenticated = operation == "scheduled-run"
        ? try authenticateScheduledTrigger(descriptor, config: config)
        : try authenticateOperatorCanary(descriptor, config: config)
    guard authenticated else { return "scheduled launcher authentication failed" }

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

private enum GitHubCliOutcome {
    case success(GitHubCliResult)
    case failure(String)
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

private func optionValues(_ arguments: [String], names: Set<String>) -> [String] {
    var values: [String] = []
    var index = 0
    while index < arguments.count {
        let argument = arguments[index]
        if names.contains(argument), index + 1 < arguments.count {
            values.append(arguments[index + 1])
            index += 2
            continue
        }
        for name in names where argument.hasPrefix("\(name)=") {
            values.append(String(argument.dropFirst(name.count + 1)))
        }
        index += 1
    }
    return values
}

private func argumentsAvoidLocalFiles(_ arguments: [String]) -> Bool {
    guard optionValues(arguments, names: ["--body-file", "--input"]).allSatisfy({ $0 == "-" }) else { return false }
    return optionValues(arguments, names: ["-F", "--field"]).allSatisfy { field in
        guard let separator = field.firstIndex(of: "=") else { return true }
        let value = String(field[field.index(after: separator)...])
        return !value.hasPrefix("@") || value == "@-"
    }
}

private func graphqlRootField(_ queryField: String) -> String? {
    let query = queryField.hasPrefix("query=") ? String(queryField.dropFirst(6)) : queryField
    let characters = Array(query)
    var braceDepth = 0, parenDepth = 0, index = 0
    var inString = false, escaped = false, inComment = false, sawSelection = false
    var roots: [String] = []
    var expectRoot = false
    while index < characters.count {
        let character = characters[index]
        if inComment {
            if character == "\n" { inComment = false }
            index += 1; continue
        }
        if inString {
            if escaped { escaped = false }
            else if character == "\\" { escaped = true }
            else if character == "\"" { inString = false }
            index += 1; continue
        }
        if character == "#" { inComment = true; index += 1; continue }
        if character == "\"" { inString = true; index += 1; continue }
        if character == "(" { parenDepth += 1; index += 1; continue }
        if character == ")" { parenDepth -= 1; if parenDepth < 0 { return nil }; index += 1; continue }
        if character == "{" {
            braceDepth += 1
            if braceDepth == 1 {
                if sawSelection { return nil }
                sawSelection = true; expectRoot = true
            }
            index += 1; continue
        }
        if character == "}" {
            if braceDepth == 2 { expectRoot = true }
            braceDepth -= 1
            if braceDepth < 0 { return nil }
            index += 1; continue
        }
        if braceDepth == 1 && parenDepth == 0 && expectRoot {
            if character.isWhitespace || character == "," { index += 1; continue }
            guard character.isLetter || character == "_" else { return nil }
            let start = index
            while index < characters.count && (characters[index].isLetter || characters[index].isNumber || characters[index] == "_") { index += 1 }
            let root = String(characters[start..<index])
            var lookahead = index
            while lookahead < characters.count && characters[lookahead].isWhitespace { lookahead += 1 }
            guard lookahead >= characters.count || characters[lookahead] != ":" else { return nil }
            roots.append(root); expectRoot = false
            continue
        }
        index += 1
    }
    guard braceDepth == 0, parenDepth == 0, !inString, roots.count == 1 else { return nil }
    return roots[0]
}

private func githubArgumentsAllowed(_ arguments: [String], repository: String) -> Bool {
    guard let command = arguments.first else { return false }
    guard argumentsUseOnlyExpectedValue(arguments, names: ["-R", "--repo"], expected: repository),
          argumentsUseOnlyExpectedValue(arguments, names: ["--hostname"], expected: "github.com"),
          argumentsAvoidLocalFiles(arguments) else { return false }

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
        let fields = optionValues(arguments, names: ["-F", "--field", "-f", "--raw-field"])
        let owners = fields.filter { $0.hasPrefix("owner=") }
        let names = fields.filter { $0.hasPrefix("name=") }
        let queries = fields.filter { $0.hasPrefix("query=") }
        guard queries.count == 1, let query = queries.first, let root = graphqlRootField(query) else { return false }
        if root == "repository" {
            let compactQuery = query.filter { !$0.isWhitespace }
            return !owners.isEmpty && owners.allSatisfy({ $0 == "owner=\(owner)" }) &&
                !names.isEmpty && names.allSatisfy({ $0 == "name=\(name)" }) &&
                compactQuery.contains("repository(owner:$owner,name:$name)")
        }
        if root == "search" {
            guard owners.isEmpty, names.isEmpty else { return false }
            let searchQueries = fields.filter { $0.hasPrefix("searchQuery=") }
            guard searchQueries.count == 1, let searchQuery = searchQueries.first else { return false }
            let value = String(searchQuery.dropFirst("searchQuery=".count))
            let escapedOwner = NSRegularExpression.escapedPattern(for: owner)
            return value.range(of: "^is:pr is:open owner:\(escapedOwner)$", options: .regularExpression) != nil ||
                value.range(of: "^is:pr is:merged owner:\(escapedOwner) merged:>=[0-9]{4}-[0-9]{2}-[0-9]{2}T[^ ]+$", options: .regularExpression) != nil
        }
        return false
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
) throws -> GitHubCliOutcome {
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
          (1...maximumGitHubOutputBytes).contains(maxOutputBytes) else { return .failure("github-cli-policy-refused") }

    let manager = FileManager.default
    let operationRoot = (config.privateDirectory as NSString).appendingPathComponent("github-cli-\(UUID().uuidString)")
    try manager.createDirectory(atPath: operationRoot, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    defer { try? manager.removeItem(atPath: operationRoot) }
    let inputPath = (operationRoot as NSString).appendingPathComponent("stdin")
    let stdoutPath = (operationRoot as NSString).appendingPathComponent("stdout")
    let stderrPath = (operationRoot as NSString).appendingPathComponent("stderr")
    try input.write(toFile: inputPath, atomically: false, encoding: .utf8)
    guard manager.createFile(atPath: stdoutPath, contents: nil, attributes: [.posixPermissions: 0o600]),
          manager.createFile(atPath: stderrPath, contents: nil, attributes: [.posixPermissions: 0o600]) else { return .failure("github-cli-io-failed") }
    let inputHandle = try FileHandle(forReadingFrom: URL(fileURLWithPath: inputPath))
    let stdoutHandle = try FileHandle(forWritingTo: URL(fileURLWithPath: stdoutPath))
    let stderrHandle = try FileHandle(forWritingTo: URL(fileURLWithPath: stderrPath))
    defer {
        inputHandle.closeFile()
        stdoutHandle.closeFile()
        stderrHandle.closeFile()
    }
    let token: String
    do { token = try githubCredentials.token(for: config, repository: repository) }
    catch { return .failure("github-cli-token-unavailable") }
    guard connected(descriptor) else { return .failure("github-cli-client-disconnected") }
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
        if !connected(descriptor) {
            try cancelProcessGroup(process)
            return .failure("github-cli-client-disconnected")
        }
        if Date() >= deadline {
            try cancelProcessGroup(process)
            return .failure("github-cli-timeout")
        }
        if stdoutSize + stderrSize > maxOutputBytes {
            try cancelProcessGroup(process)
            return .failure("github-cli-output-limit")
        }
        usleep(50_000)
    }
    stdoutHandle.synchronizeFile()
    stderrHandle.synchronizeFile()
    let stdoutData = try Data(contentsOf: URL(fileURLWithPath: stdoutPath))
    let stderrData = try Data(contentsOf: URL(fileURLWithPath: stderrPath))
    guard stdoutData.count + stderrData.count <= maxOutputBytes else { return .failure("github-cli-output-limit") }
    let exitCode = process.exitedNormally ? process.terminationStatus : min(255, 128 + max(1, process.terminationSignal))
    return .success(GitHubCliResult(
        exitCode: exitCode,
        stdout: String(decoding: stdoutData, as: UTF8.self),
        stderr: String(decoding: stderrData, as: UTF8.self)
    ))
}

private func respondGitHubCli(_ descriptor: Int32, _ outcome: GitHubCliOutcome) {
    let object: [String: Any]
    switch outcome {
    case .success(let result):
        object = [
            "ok": true,
            "exitCode": Int(result.exitCode),
            "stdoutBase64": Data(result.stdout.utf8).base64EncodedString(),
            "stderrBase64": Data(result.stderr.utf8).base64EncodedString()
        ]
    case .failure(let code):
        object = ["ok": false, "error": code]
    }
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

    let token = try githubCredentials.token(for: config, repository: expectedRepo, forceRefresh: true)
    guard connected(descriptor) else { return false }
    let credentialPath = (operationRoot as NSString).appendingPathComponent("github-credential")
    guard manager.createFile(atPath: credentialPath, contents: Data(token.utf8), attributes: [.posixPermissions: 0o600]) else {
        return false
    }
    let helper = "!f() { test \"$1\" = get || exit 0; printf '%s\\n' username=x-access-token; printf '%s\\n' password=\"$(/bin/cat \(shellQuote(credentialPath)))\"; }; f"
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
    try assertRealDirectory(config.privateDirectory)
    try FileManager.default.createDirectory(atPath: config.privateDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    try assertRealDirectory(config.privateDirectory)
    if testingConfigPath() == nil {
        guard chown(config.privateDirectory, 0, config.runtimeGid) == 0,
              chmod(config.privateDirectory, 0o710) == 0 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }
    }
    try assertRealDirectory(config.privateDirectory)
    guard !hasExtendedAcl(config.privateDirectory) else {
        throw NSError(domain: "KaizenPublicationBroker", code: 12)
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
