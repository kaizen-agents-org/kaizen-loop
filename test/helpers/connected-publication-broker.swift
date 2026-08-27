import Darwin
import Foundation

// Protocol canary for the production publication client. `readRequest`,
// `connected`, `spawnProcess`, `cancelProcessGroup`, and `runProcess` must stay
// aligned with scripts/macos/kaizen-publication-broker.swift: a newline-framed
// request that remains connected through import, and a true client close that
// cancels the child process group.

private let maximumRequestBytes = 1_048_576

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

private func respond(_ descriptor: Int32, _ ok: Bool, error: String? = nil) {
    let object: [String: Any]
    if ok {
        object = ["ok": true]
    } else if let error {
        object = ["ok": false, "error": error]
    } else {
        object = ["ok": false]
    }
    guard var data = try? JSONSerialization.data(withJSONObject: object) else { return }
    data.append(0x0a)
    _ = data.withUnsafeBytes { Darwin.write(descriptor, $0.baseAddress, data.count) }
    _ = shutdown(descriptor, SHUT_RDWR)
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

    var terminationStatus: Int32 {
        waitUntilExit()
        return waitStatus.map { ($0 >> 8) & 0xff } ?? -1
    }
}

private func withCStringArray<Result>(
    _ values: [String],
    _ body: (UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>) throws -> Result
) throws -> Result {
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
    environment: [String: String]
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
    for (source, destination) in [
        (nullDescriptor, STDIN_FILENO),
        (STDERR_FILENO, STDOUT_FILENO),
        (STDERR_FILENO, STDERR_FILENO)
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

private func bindSocket(_ path: String) throws -> Int32 {
    try? FileManager.default.removeItem(atPath: path)
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
    guard result == 0, listen(descriptor, 1) == 0 else {
        let code = errno; close(descriptor); throw NSError(domain: NSPOSIXErrorDomain, code: Int(code))
    }
    return descriptor
}

enum Mode {
    case importClone(source: String, destination: String)
    case sleep(seconds: String)
}

let arguments = Array(CommandLine.arguments.dropFirst())
guard arguments.count >= 3 else {
    FileHandle.standardError.write(Data("usage: connected-publication-broker <socket> import <source> <destination> [pid-file] | <socket> sleep <seconds> [pid-file]\n".utf8))
    exit(2)
}
let socketPath = arguments[0]
let mode: Mode
let pidPath: String?
if arguments[1] == "sleep" {
    mode = .sleep(seconds: arguments[2])
    pidPath = arguments.count > 3 ? arguments[3] : nil
} else if arguments[1] == "import", arguments.count >= 4 {
    mode = .importClone(source: arguments[2], destination: arguments[3])
    pidPath = arguments.count > 4 ? arguments[4] : nil
} else {
    FileHandle.standardError.write(Data("usage: connected-publication-broker <socket> import <source> <destination> [pid-file] | <socket> sleep <seconds> [pid-file]\n".utf8))
    exit(2)
}

do {
    let listening = try bindSocket(socketPath)
    let descriptor = accept(listening, nil, nil)
    guard descriptor >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
    _ = try readRequest(descriptor)
    let environment: [String: String] = [
        "HOME": "/var/empty",
        "PATH": "/usr/bin:/bin",
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_ALLOW_PROTOCOL": "file"
    ]
    let child: SpawnedProcess
    switch mode {
    case .importClone(let source, let destination):
        child = try spawnProcess(
            executable: "/usr/bin/git",
            arguments: ["clone", "--bare", "--no-local", source, destination],
            environment: environment
        )
    case .sleep(let seconds):
        child = try spawnProcess(executable: "/bin/sleep", arguments: [seconds], environment: environment)
    }
    if let pidPath {
        try "\(child.processIdentifier)\n".write(toFile: pidPath, atomically: true, encoding: .utf8)
    }
    while child.isRunning {
        if !connected(descriptor) {
            try cancelProcessGroup(child)
            respond(descriptor, false, error: "disconnected")
            exit(0)
        }
        usleep(50_000)
    }
    guard child.terminationStatus == 0, connected(descriptor) else {
        respond(descriptor, false, error: "import-failed")
        exit(1)
    }
    respond(descriptor, true)
} catch {
    FileHandle.standardError.write(Data("connected-publication-broker failed: \(error)\n".utf8))
    exit(1)
}
