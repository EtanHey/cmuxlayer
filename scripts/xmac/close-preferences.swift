import Foundation
import CoreFoundation

// Read-only preflight for the same volatile arguments passed to the GUI.
let keys = ["warnBeforeClosingWorkspace", "warnBeforeClosingTabShortcut"]
let defaults = UserDefaults.standard
let persistentBefore = defaults.persistentDomain(forName: "com.cmuxterm.app") ?? [:]
let arguments = defaults.volatileDomain(forName: UserDefaults.argumentDomain)
for key in keys {
    guard let value = defaults.object(forKey: key) as? NSNumber,
          CFGetTypeID(value) == CFBooleanGetTypeID(), !value.boolValue,
          let argument = arguments[key] as? NSNumber,
          CFGetTypeID(argument) == CFBooleanGetTypeID(), !argument.boolValue else {
        fputs("close preference is not a volatile Boolean false: \(key)\n", stderr)
        exit(1)
    }
}
let persistentAfter = defaults.persistentDomain(forName: "com.cmuxterm.app") ?? [:]
guard NSDictionary(dictionary: persistentBefore).isEqual(to: persistentAfter) else { exit(2) }
print("{\"status\":\"PASS\",\"domain\":\"NSArgumentDomain\",\"typed_boolean_false\":true,\"persistent_domain_unchanged\":true}")
