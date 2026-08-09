import Darwin
import Foundation

private struct SupervisorConfig: Decodable {
    let runtimeUser: String
    let runtimeUid: UInt32
    let runtimeGid: UInt32
    let runtimeHome: String
    let publicationSocketPath: String
    let nodeExecutable: String
    let cliPath: String
    let gitExecutable: String
}

private func configPath() -> String {
    if let value = ProcessInfo.processInfo.environment["KAIZEN_BROKER_TEST_CONFIG"],
       value.hasPrefix("/private/tmp/kaizen-broker-test-") || value.hasPrefix("/tmp/kaizen-broker-test-") { return value }
    return "/Library/Application Support/KaizenLoop/publication-broker.plist"
}

private func validatedToolPath(_ value: String) -> String? {
    guard !value.isEmpty, value.utf8.count <= 16_384,
          !value.contains("\0"), !value.contains("\n"), !value.contains("\r") else { return nil }
    let directories = value.split(separator: ":", omittingEmptySubsequences: false)
    guard directories.count <= 128,
          directories.allSatisfy({ !$0.isEmpty && $0.hasPrefix("/") && $0.utf8.count <= 4_096 }) else { return nil }
    return value
}

private func dropPrivileges(_ config: SupervisorConfig) -> Never {
    if ProcessInfo.processInfo.environment["KAIZEN_BROKER_TEST_CONFIG"] != nil {
        guard getuid() == config.runtimeUid, getgid() == config.runtimeGid else { exit(126) }
    } else {
        guard let baseGid = Int32(exactly: config.runtimeGid),
              initgroups(config.runtimeUser, baseGid) == 0,
              setgid(config.runtimeGid) == 0,
              setuid(config.runtimeUid) == 0 else {
            exit(126)
        }
    }
    let arguments = CommandLine.arguments
    if arguments.count == 7 && arguments[1] == "run",
       let toolPath = validatedToolPath(arguments[5]),
       let publicationTimeoutMs = Int(arguments[6]),
       (10_000...3_600_000).contains(publicationTimeoutMs) {
        let capability = arguments[2]
        let project = arguments[3]
        let job = arguments[4]
        guard registerSupervisor(socketPath: config.publicationSocketPath, capability: capability) else { exit(126) }
        let environment = [
            "HOME=\(config.runtimeHome)",
            "USER=\(config.runtimeUser)",
            "LOGNAME=\(config.runtimeUser)",
            "PATH=\(toolPath)",
            "KAIZEN_HOME=\(config.runtimeHome)/.kaizen",
            "KAIZEN_GITHUB_TOKEN_SOCKET=\(config.publicationSocketPath)",
            "KAIZEN_GITHUB_BROKER_CAPABILITY=\(capability)",
            "KAIZEN_GITHUB_PUBLICATION_TIMEOUT_MS=\(publicationTimeoutMs)"
        ]
        let argv = [config.nodeExecutable, config.cliPath, "run", "--project", project, "--scheduled", "--job", job]
        exec(config.nodeExecutable, argv, environment)
    }
    if arguments.count == 4 && arguments[1] == "import" {
        let source = arguments[2]
        let destination = arguments[3]
        let environment = [
            "HOME=/var/empty",
            "PATH=/usr/bin:/bin",
            "GIT_CONFIG_GLOBAL=/dev/null",
            "GIT_CONFIG_NOSYSTEM=1",
            "GIT_ALLOW_PROTOCOL=file"
        ]
        let argv = [config.gitExecutable, "clone", "--bare", "--no-local", source, destination]
        exec(config.gitExecutable, argv, environment)
    }
    exit(2)
}

private func registerSupervisor(socketPath: String, capability: String) -> Bool {
    guard socketPath.utf8.count < MemoryLayout<sockaddr_un>.size - 2 else { return false }
    for _ in 0..<40 {
        let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
        if descriptor < 0 { return false }
        var address = sockaddr_un(); address.sun_family = sa_family_t(AF_UNIX)
        withUnsafeMutableBytes(of: &address.sun_path) { bytes in
            bytes.initializeMemory(as: UInt8.self, repeating: 0)
            for (index, byte) in socketPath.utf8.enumerated() { bytes[index] = byte }
        }
        let length = socklen_t(MemoryLayout<sa_family_t>.size + socketPath.utf8.count + 1)
        let connected = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(descriptor, $0, length) }
        } == 0
        if connected {
            let request = "{\"version\":1,\"operation\":\"supervisor-register\",\"capability\":\"\(capability)\"}\n"
            let requestData = Array(request.utf8)
            var sent = 0
            while sent < requestData.count {
                let count = requestData.withUnsafeBytes {
                    Darwin.write(descriptor, $0.baseAddress!.advanced(by: sent), requestData.count - sent)
                }
                if count <= 0 { break }
                sent += count
            }
            var response = Data()
            var buffer = [UInt8](repeating: 0, count: 64)
            while sent == requestData.count && response.count <= 4_096 && !response.contains(0x0a) {
                let count = Darwin.read(descriptor, &buffer, buffer.count)
                if count <= 0 { break }
                response.append(buffer, count: count)
            }
            close(descriptor)
            if String(data: response, encoding: .utf8) == "{\"ok\":true}\n" { return true }
        } else {
            close(descriptor)
        }
        usleep(50_000)
    }
    return false
}

private func exec(_ executable: String, _ arguments: [String], _ environment: [String]) -> Never {
    var argv = arguments.map { strdup($0) }
    argv.append(nil)
    var envp = environment.map { strdup($0) }
    envp.append(nil)
    execve(executable, &argv, &envp)
    exit(127)
}

do {
    let config = try PropertyListDecoder().decode(SupervisorConfig.self, from: Data(contentsOf: URL(fileURLWithPath: configPath())))
    guard geteuid() == 0 || ProcessInfo.processInfo.environment["KAIZEN_BROKER_TEST_CONFIG"] != nil else { exit(126) }
    dropPrivileges(config)
} catch {
    exit(126)
}
