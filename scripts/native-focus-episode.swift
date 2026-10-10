import AppKit
import ApplicationServices
import Foundation
import Darwin

// Private single-episode transport: stdin/stdout only, no global focus query.
let observer = "NSWORKSPACE_FOREGROUND_DIRECT_PID_AX"
let clock = ISO8601DateFormatter()
clock.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
func utc() -> String { clock.string(from: Date()) }
let sessionID = UUID().uuidString
let args = CommandLine.arguments
let began = ProcessInfo.processInfo.systemUptime
var events: [[String: Any]] = []
var actionCount = 0
var sequence = 0
var deadline = Date.distantPast
var runID = "", dispatchID = "", threadID = ""
struct Stop: Error { let reason: String }
func require(_ condition: Bool, _ reason: String) throws { if !condition { throw Stop(reason: reason) } }
func budget(_ reserve: Double = 0) throws { try require(Date().addingTimeInterval(reserve) < deadline, "EPISODE_DEADLINE") }
func event(_ operation: String, _ facts: [String: Any]) {
    var row = facts; row["operation"] = operation; row["observedUTC"] = utc(); events.append(row)
}
func checked(_ error: AXError, _ operation: String, _ facts: [String: Any] = [:]) throws {
    var row = facts; row["errorCode"] = Int(error.rawValue)
    // Raw code is authoritative; unknown SDK enum names are not invented.
    row["errorName"] = String(describing: error)
    event(operation, row); try budget()
    try require(error == .success, "AX_API_FAILURE:" + operation)
}
func attribute(_ element: AXUIElement, _ name: String) throws -> CFTypeRef {
    try budget(); var value: CFTypeRef?
    let error = AXUIElementCopyAttributeValue(element, name as CFString, &value)
    try checked(error, name, ["valuePresent": value != nil])
    guard let value else { throw Stop(reason: "AX_VALUE_MISSING:" + name) }; return value
}
func element(_ value: CFTypeRef) throws -> AXUIElement {
    try require(CFGetTypeID(value) == AXUIElementGetTypeID(), "AX_TYPE_MISMATCH")
    return unsafeBitCast(value, to: AXUIElement.self)
}
func window(_ app: AXUIElement, _ owner: pid_t) throws -> AXUIElement {
    var appPID: pid_t = 0
    try checked(AXUIElementGetPid(app, &appPID), "applicationPID", ["ownerPID": Int(appPID)])
    let selected = try element(attribute(app, kAXFocusedWindowAttribute)); try validWindow(selected, owner)
    try require(appPID == owner, "APPLICATION_OWNER_CHANGED"); return selected
}
func validWindow(_ value: AXUIElement, _ owner: pid_t) throws {
    var pid: pid_t = 0
    try checked(AXUIElementGetPid(value, &pid), "windowPID", ["ownerPID": Int(pid)])
    let role = try attribute(value, kAXRoleAttribute) as? String
    event("windowRole", ["roleIsAXWindow": role == kAXWindowRole])
    try require(pid == owner && role == kAXWindowRole, "WINDOW_OWNER_OR_ROLE_CHANGED")
}
// A bounded independent ps subprocess; no pattern enumeration/kill.
func process(_ pid: pid_t) throws -> [String: String] {
    var fields: [String: String] = ["pid": String(pid)]
    for key in ["uid", "lstart", "comm", "args"] {
        try budget(2)
        let task = Process(), pipe = Pipe()
        task.executableURL = URL(fileURLWithPath: "/bin/ps")
        task.arguments = ["-ww", "-p", String(pid), "-o", key + "="]
        task.environment = ["PATH": "/usr/bin:/bin", "LC_ALL": "C"]
        task.standardOutput = pipe; task.standardError = FileHandle.nullDevice
        try task.run()
        let end = min(Date().addingTimeInterval(1), deadline)
        while task.isRunning && Date() < end { Thread.sleep(forTimeInterval: 0.005) }
        if task.isRunning { event("ps.timeout", ["pid": Int(task.processIdentifier), "remaining": "UNKNOWN_RETAINED", "signalSent": false]); throw Stop(reason: "PS_TIMEOUT_RETAINED") }
        let bytes = pipe.fileHandleForReading.readDataToEndOfFile()
        try require(task.terminationStatus == 0 && bytes.count <= 8192, "PS_UNAVAILABLE")
        fields[key] = String(data: bytes, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
        event("ps." + key, ["pid": Int(pid), "value": fields[key] as Any? ?? NSNull()])
    }
    try require(fields["uid"] == "501" && fields.values.allSatisfy { !$0.isEmpty }, "PROCESS_UNBOUND")
    return fields
}
func metadata(_ app: NSRunningApplication) throws -> [String: String] {
    try require(!app.isTerminated, "APPLICATION_EXITED")
    guard let bundle = app.bundleURL?.path, let executable = app.executableURL?.path,
          let launch = app.launchDate, let identifier = app.bundleIdentifier else { throw Stop(reason: "APPLICATION_IDENTITY_MISSING") }
    return ["pid": String(app.processIdentifier), "bundle": bundle, "executable": executable,
            "launchUTC": clock.string(from: launch), "bundleIdentifier": identifier]
}
func foreground() throws -> (NSRunningApplication, [String: String], [String: String]) {
    try budget(); RunLoop.current.run(until: Date().addingTimeInterval(0.005))
    guard let app = NSWorkspace.shared.frontmostApplication else { throw Stop(reason: "FOREGROUND_UNAVAILABLE") }
    let meta = try metadata(app); event("NSWorkspace.frontmostApplication", meta)
    let binding = try process(app.processIdentifier)
    let parser = DateFormatter(); parser.locale = Locale(identifier: "en_US_POSIX"); parser.dateFormat = "EEE MMM d HH:mm:ss yyyy"
    try require(binding["comm"] == meta["executable"] && parser.date(from: binding["lstart"]!)?.timeIntervalSince1970.rounded(.down) == app.launchDate!.timeIntervalSince1970.rounded(.down), "NSWORKSPACE_PROCESS_DISAGREEMENT")
    return (app, meta, binding)
}
final class Token {
    let id = UUID().uuidString, running: NSRunningApplication, app: AXUIElement, window: AXUIElement
    let metadata: [String: String], process: [String: String]
    var capabilities: [String: Any] = [:]
    init(_ running: NSRunningApplication, _ app: AXUIElement, _ window: AXUIElement, _ metadata: [String: String], _ process: [String: String]) {
        self.running = running; self.app = app; self.window = window; self.metadata = metadata; self.process = process
    }
}
var tokens: [String: Token] = [:]
var attachAttempted = false
func unchanged(_ token: Token) throws {
    try require(try metadata(token.running) == token.metadata, "TARGET_METADATA_CHANGED")
    try require(try process(token.running.processIdentifier) == token.process, "TARGET_PROCESS_CHANGED")
    try validWindow(token.window, token.running.processIdentifier)
}
func singleNativeWindow(_ token: Token) throws {
    let raw = try attribute(token.app, kAXWindowsAttribute)
    try require(CFGetTypeID(raw) == CFArrayGetTypeID(), "AX_WINDOWS_TYPE_MISMATCH")
    let array = raw as! [CFTypeRef]
    event("AXWindows", ["count": array.count]); try require(array.count == 1, "MULTIPLE_OR_MISSING_NATIVE_WINDOWS")
    let only = try element(array[0]); try validWindow(only, token.running.processIdentifier)
    let equal = CFEqual(only, token.window); event("AXWindows.CFEqual", ["equal": equal])
    try require(equal, "NATIVE_WINDOW_BINDING_CHANGED")
}
func check(_ token: Token) throws {
    try unchanged(token)
    let (_, meta, binding) = try foreground()
    try require(meta == token.metadata && binding == token.process, "HUMAN_OR_FOREGROUND_CHANGE")
    let first = try window(token.app, token.running.processIdentifier)
    let second = try window(AXUIElementCreateApplication(token.running.processIdentifier), token.running.processIdentifier)
    let equal = CFEqual(first, second) && CFEqual(second, token.window)
    event("CFEqual", ["sameFocusedWindow": equal, "token": token.id])
    if token.metadata["bundle"] == "/Applications/cmux.app" { try singleNativeWindow(token) }
    let (_, after, processAfter) = try foreground()
    try require(equal && after == meta && processAfter == binding, "FOCUSED_WINDOW_CHANGED")
}
func capability(_ token: Token) throws {
    var names: CFArray?
    let error = AXUIElementCopyActionNames(token.window, &names)
    let actions = names as? [String]
    let raise = error == .success ? actions?.contains(kAXRaiseAction) : nil
    event("AXUIElementCopyActionNames", ["errorCode": Int(error.rawValue), "namesAvailable": actions != nil, "supportsAXRaise": raise as Any? ?? NSNull()])
    var flag = DarwinBoolean(false)
    let setterError = AXUIElementIsAttributeSettable(token.app, kAXFocusedWindowAttribute as CFString, &flag)
    event("AXUIElementIsAttributeSettable", ["errorCode": Int(setterError.rawValue), "attribute": kAXFocusedWindowAttribute, "settable": setterError == .success ? flag.boolValue as Any : NSNull()])
    token.capabilities = ["recipe": "ACTIVATE_EXISTING_RAISE_SET_FOCUSED_WINDOW", "raiseError": Int(error.rawValue), "raiseSupported": raise as Any? ?? NSNull(), "setterError": Int(setterError.rawValue), "focusedWindowSettable": setterError == .success ? flag.boolValue as Any : NSNull()]
    try budget(); try require(raise == true && setterError == .success && flag.boolValue, "RESTORATION_RECIPE_UNSUPPORTED")
}
func capture(_ kind: String) throws -> Token {
    let (running, meta, binding) = try foreground(), app = AXUIElementCreateApplication(running.processIdentifier)
    let first = try window(app, running.processIdentifier)
    let token = Token(running, app, first, meta, binding)
    // Keep the token even on later failure, but never expose a failed token as admitted.
    tokens[kind] = token; try check(token); try capability(token)
    if kind == "cmux" { try require(meta["bundle"] == "/Applications/cmux.app", "CMUX_BUNDLE_MISMATCH") }
    try check(token); return token
}
func restore(_ target: Token, _ expected: Token) throws {
    // One chosen recipe. Every mutation is preceded by a checked observed state.
    try check(expected); try unchanged(target); try capability(target); try budget(10)
    if target.metadata == expected.metadata && CFEqual(target.window, expected.window) { try check(target); return }
    actionCount += 1
    let ack = target.running.activate(options: [])
    event("NSRunningApplication.activate", ["requestAccepted": ack]); try require(ack, "ACTIVATION_UNPROVED")
    let (_, meta, binding) = try foreground()
    try require(meta == target.metadata && binding == target.process, "ACTIVATION_FOREGROUND_UNPROVED")
    let current = Token(target.running, target.app, try window(target.app, target.running.processIdentifier), meta, binding)
    try check(current); try unchanged(target); try budget(6); actionCount += 1
    try checked(AXUIElementPerformAction(target.window, kAXRaiseAction as CFString), "AXRaise")
    let afterRaise = Token(target.running, target.app, try window(target.app, target.running.processIdentifier), meta, binding)
    try check(afterRaise); try unchanged(target); try budget(3); actionCount += 1
    try checked(AXUIElementSetAttributeValue(target.app, kAXFocusedWindowAttribute as CFString, target.window), "setAXFocusedWindow")
    try check(target) // ACKs alone never establish restoration.
}
func send(_ row: [String: Any]) throws {
    let bytes = try JSONSerialization.data(withJSONObject: row, options: [.sortedKeys])
    FileHandle.standardOutput.write(bytes); FileHandle.standardOutput.write(Data([10]))
}
do {
    try require(args.count == 5 && getuid() == 501, "ACCOUNT_OR_ARGUMENT_MISMATCH")
    runID = args[1]; dispatchID = args[2]; threadID = args[3]
    try require(threadID == "mcp:8fd6b8a4-87bd-466f-81fc-4e57713c6a2d" && !dispatchID.isEmpty, "FOREIGN_COORDINATION")
    guard let end = clock.date(from: args[4]) else { throw Stop(reason: "DEADLINE_MISSING") }; deadline = end
    try require(deadline.timeIntervalSinceNow <= 900, "EPISODE_TOO_LONG"); try budget(60)
    let trust = AXIsProcessTrusted(); event("AXIsProcessTrusted", ["trusted": trust]); try require(trust, "AX_CONTEXT_NOT_TRUSTED")
    try checked(AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 2), "processLocalMessagingTimeout")
    try send(["status": "HELPER_STARTED", "session": sessionID, "helperPID": Int(getpid()), "helperPPID": Int(getppid()), "uid": Int(getuid()), "helperExecutable": URL(fileURLWithPath: args[0]).resolvingSymlinksInPath().path, "events": events])
    while let line = readLine() {
        events = []; try budget(); try require(line.utf8.count <= 4096, "COMMAND_TOO_LARGE")
        let raw = try JSONSerialization.jsonObject(with: Data(line.utf8))
        guard let command = raw as? [String: Any] else { throw Stop(reason: "COMMAND_MALFORMED") }
        sequence += 1
        try require(command["session"] as? String == sessionID && command["sequence"] as? Int == sequence, "SESSION_OR_SEQUENCE_CHANGED")
        let verb = command["command"] as? String ?? "", kind = command["kind"] as? String ?? ""
        var result: [String: Any] = ["observer": observer, "session": sessionID, "sequence": sequence, "runId": runID, "dispatchId": dispatchID, "threadId": threadID, "deadlineUTC": args[4], "observedUTC": utc(), "helperPID": Int(getpid()), "uiActions": actionCount, "keyboardFocusPreserved": "UNMEASURED"]
        do {
            if verb == "attach-cmux" {
                try require(!attachAttempted && tokens["cmux"] == nil, "NO_ATTACH_REPLAY"); attachAttempted = true
                guard let original = tokens["original"], let targetPID = command["pid"] as? Int,
                      let running = NSRunningApplication(processIdentifier: pid_t(targetPID)),
                      let expected = command["process"] as? [String: String] else { throw Stop(reason: "CMUX_ATTACH_IDENTITY_MISSING") }
                try check(original)
                let meta = try metadata(running)
                let actualProcess = try process(running.processIdentifier)
                try require(meta["bundle"] == "/Applications/cmux.app" && actualProcess == expected, "CMUX_ATTACH_PROCESS_CHANGED")
                try budget(10); actionCount += 1
                let ack = running.activate(options: [])
                event("attachExistingCmux.activate", ["requestAccepted": ack]); try require(ack, "CMUX_ATTACH_UNPROVED")
                let token = try capture("cmux")
                try require(token.metadata == meta && token.process == expected, "CMUX_ATTACH_TARGET_CHANGED")
                result["token"] = token.id; result["kind"] = "cmux"; result["app"] = token.metadata; result["process"] = token.process; result["capabilities"] = token.capabilities
                result["sameFocusedWindow"] = true; result["nativeWindowCount"] = 1; result["nativeWindowsEqual"] = true
            } else if verb == "capture-original" || verb == "capture-cmux" {
                let name = verb == "capture-original" ? "original" : "cmux"
                try require(tokens[name] == nil, "NO_CAPTURE_REPLAY")
                let token = try capture(name)
                result["token"] = token.id; result["kind"] = name; result["app"] = token.metadata; result["process"] = token.process; result["capabilities"] = token.capabilities
                result["sameFocusedWindow"] = true; if name == "cmux" { result["nativeWindowCount"] = 1; result["nativeWindowsEqual"] = true }
            } else if verb == "check-token" || verb == "restore-token" {
                guard let target = tokens[kind], command["token"] as? String == target.id else { throw Stop(reason: "TOKEN_LOST_OR_FOREIGN") }
                if verb == "restore-token" {
                    guard let expected = tokens[command["expectedKind"] as? String ?? ""], command["expectedToken"] as? String == expected.id else { throw Stop(reason: "EXPECTED_TOKEN_MISSING") }
                    try restore(target, expected); result["restorationProved"] = true
                } else { try check(target) }
                result["token"] = target.id; result["sameFocusedWindow"] = true
                if target.metadata["bundle"] == "/Applications/cmux.app" { result["nativeWindowCount"] = 1; result["nativeWindowsEqual"] = true }
            } else { try require(verb == "finish", "UNSUPPORTED_COMMAND") }
            result["status"] = "OBSERVED"; result["events"] = events; result["uiActions"] = actionCount; result["completedUTC"] = utc(); try send(result)
            if verb == "finish" { exit(0) }
        } catch {
            result["status"] = verb == "restore-token" ? "RESTORATION_UNPROVED" : "OBSERVATION_UNAVAILABLE_PRECASE"
            result["error"] = String(describing: error); result["events"] = events; result["uiActions"] = actionCount; result["completedUTC"] = utc(); try send(result)
            exit(2) // Reference/process/observation loss terminates this episode; no reconstruction.
        }
    }
    throw Stop(reason: "TRANSPORT_CLOSED")
} catch {
    try? send(["status": "HELPER_UNAVAILABLE", "error": String(describing: error), "events": events, "endedUTC": utc(), "uiActions": actionCount, "helperPID": Int(getpid())]); exit(2)
}
