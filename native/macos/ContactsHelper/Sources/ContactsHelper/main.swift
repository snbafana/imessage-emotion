import Contacts
import Foundation

enum HelperError: Error, CustomStringConvertible {
  case usage
  case contactsAccessDenied
  case encodingFailed

  var description: String {
    switch self {
    case .usage:
      return "usage: imessage-emotion-native-helper contacts status|dump"
    case .contactsAccessDenied:
      return "contacts access denied"
    case .encodingFailed:
      return "could not encode contacts output"
    }
  }
}

struct ContactRecord: Encodable {
  let sourceId: String
  let displayName: String
  let company: String?
  let avatarUrl: String?
  let phoneNumbers: [String]
  let emails: [String]
}

func writeJSON<T: Encodable>(_ value: T) throws {
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.withoutEscapingSlashes]
  let data = try encoder.encode(value)
  guard let output = String(data: data, encoding: .utf8) else {
    throw HelperError.encodingFailed
  }
  print(output)
}

func contactsAuthorizationStatus() -> String {
  switch CNContactStore.authorizationStatus(for: .contacts) {
  case .authorized:
    return "authorized"
  case .notDetermined:
    return "not_determined"
  case .denied:
    return "denied"
  case .restricted:
    return "restricted"
  @unknown default:
    return "unknown"
  }
}

func ensureContactsAccess(store: CNContactStore) throws {
  switch CNContactStore.authorizationStatus(for: .contacts) {
  case .authorized:
    return
  case .notDetermined:
    let semaphore = DispatchSemaphore(value: 0)
    final class AccessState {
      var granted = false
    }
    let state = AccessState()
    store.requestAccess(for: .contacts) { granted, _ in
      state.granted = granted
      semaphore.signal()
    }
    semaphore.wait()
    if !state.granted {
      throw HelperError.contactsAccessDenied
    }
  case .denied, .restricted:
    throw HelperError.contactsAccessDenied
  @unknown default:
    throw HelperError.contactsAccessDenied
  }
}

func nilIfEmpty(_ value: String) -> String? {
  let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
  return trimmed.isEmpty ? nil : trimmed
}

func preferredDisplayName(for contact: CNContact) -> String {
  if let formatted = CNContactFormatter.string(from: contact, style: .fullName),
    let name = nilIfEmpty(formatted)
  {
    return name
  }
  if let nickname = nilIfEmpty(contact.nickname) {
    return nickname
  }
  if let organization = nilIfEmpty(contact.organizationName) {
    return organization
  }
  return "Unknown"
}

func dumpContacts() throws -> [ContactRecord] {
  let store = CNContactStore()
  try ensureContactsAccess(store: store)

  let keysToFetch: [CNKeyDescriptor] = [
    CNContactIdentifierKey as CNKeyDescriptor,
    CNContactGivenNameKey as CNKeyDescriptor,
    CNContactMiddleNameKey as CNKeyDescriptor,
    CNContactFamilyNameKey as CNKeyDescriptor,
    CNContactNicknameKey as CNKeyDescriptor,
    CNContactOrganizationNameKey as CNKeyDescriptor,
    CNContactImageDataAvailableKey as CNKeyDescriptor,
    CNContactPhoneNumbersKey as CNKeyDescriptor,
    CNContactEmailAddressesKey as CNKeyDescriptor,
    CNContactFormatter.descriptorForRequiredKeys(for: .fullName),
  ]

  let request = CNContactFetchRequest(keysToFetch: keysToFetch)
  request.sortOrder = .givenName

  var records: [ContactRecord] = []
  try store.enumerateContacts(with: request) { contact, _ in
    records.append(
      ContactRecord(
        sourceId: contact.identifier,
        displayName: preferredDisplayName(for: contact),
        company: nilIfEmpty(contact.organizationName),
        avatarUrl: contact.imageDataAvailable ? "addressbook://\(contact.identifier)" : nil,
        phoneNumbers: contact.phoneNumbers.map { $0.value.stringValue }.filter { !$0.isEmpty },
        emails: contact.emailAddresses.compactMap { labeledValue in
          let value = labeledValue.value as String
          return value.isEmpty ? nil : value
        }
      )
    )
  }

  return records
}

do {
  let args = CommandLine.arguments.dropFirst()
  guard args.count == 2, args.first == "contacts" else {
    throw HelperError.usage
  }

  switch args.dropFirst().first {
  case "status":
    try writeJSON(["status": contactsAuthorizationStatus()])
  case "dump":
    try writeJSON(dumpContacts())
  default:
    throw HelperError.usage
  }
} catch {
  fputs("\(error)\n", stderr)
  exit(1)
}
