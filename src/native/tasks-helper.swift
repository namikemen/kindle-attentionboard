import Darwin
import EventKit
import Foundation

struct CalendarEventItem: Codable {
    let id: String
    let title: String
    let start: String
    let end: String
    let isAllDay: Bool
    let calendarName: String
    let location: String?
    let notes: String?
}

struct ReminderItem: Codable {
    let id: String
    let title: String
    let isCompleted: Bool
    let priority: Int
    let listName: String
    let dueDate: String?
    let creationDate: String?
    let notes: String?
}

struct SchedulePayload: Codable {
    let calendarAuthorized: Bool
    let remindersAuthorized: Bool
    let events: [CalendarEventItem]
    let reminders: [ReminderItem]
}

struct MCPListEventsPayload: Decodable {
    struct MCPEvent: Decodable {
        let event_id: String?
        let title: String?
        let start: String?
        let end: String?
        let all_day: Bool?
        let calendar_name: String?
        let location: String?
        let notes: String?
    }
    let count: Int?
    let items: [MCPEvent]?
}

let isoFormatter = ISO8601DateFormatter()

func findAppleCalendarMcpHelper() -> String? {
    let fm = FileManager.default
    let buildDir = (NSHomeDirectory() as NSString).appendingPathComponent(".apple-mcps/build")
    guard let entries = try? fm.contentsOfDirectory(atPath: buildDir) else { return nil }

    var candidates: [(path: String, mtime: Date)] = []
    for entry in entries where entry.hasPrefix("apple-calendar-pim-bridge-") {
        let fullEntry = (buildDir as NSString).appendingPathComponent(entry)
        let path1 = (fullEntry as NSString).appendingPathComponent("Apple Calendar MCP Helper.app/Contents/MacOS/apple-calendar-pim-bridge")
        let path2 = (fullEntry as NSString).appendingPathComponent("Contents/MacOS/apple-calendar-pim-bridge")
        for p in [path1, path2] {
            if fm.isExecutableFile(atPath: p) {
                let attrs = try? fm.attributesOfItem(atPath: p)
                let mtime = (attrs?[.modificationDate] as? Date) ?? Date.distantPast
                candidates.append((p, mtime))
            }
        }
    }
    candidates.sort { $0.mtime > $1.mtime }
    return candidates.first?.path
}

func fetchEventsViaMcpHelper(startIso: String, endIso: String) -> [CalendarEventItem]? {
    guard let exe = findAppleCalendarMcpHelper() else { return nil }

    typealias SetDisclaim = @convention(c) (UnsafeMutablePointer<posix_spawnattr_t?>, Bool) -> Int32
    guard let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_spawnattrs_setdisclaim") else {
        return nil
    }

    var attr: posix_spawnattr_t?
    guard posix_spawnattr_init(&attr) == 0 else { return nil }
    defer { posix_spawnattr_destroy(&attr) }
    _ = unsafeBitCast(sym, to: SetDisclaim.self)(&attr, true)

    var pipeFds: [Int32] = [0, 0]
    guard pipe(&pipeFds) == 0 else { return nil }

    var fileActions: posix_spawn_file_actions_t?
    guard posix_spawn_file_actions_init(&fileActions) == 0 else {
        close(pipeFds[0])
        close(pipeFds[1])
        return nil
    }
    defer { posix_spawn_file_actions_destroy(&fileActions) }

    posix_spawn_file_actions_addclose(&fileActions, pipeFds[0])
    posix_spawn_file_actions_adddup2(&fileActions, pipeFds[1], STDOUT_FILENO)
    posix_spawn_file_actions_addclose(&fileActions, pipeFds[1])

    let reqJson = "{\"start\":\"\(startIso)\",\"end\":\"\(endIso)\",\"limit\":80}"
    let args = [exe, "list-calendar-events", reqJson].map { strdup($0) } + [nil]
    defer { args.forEach { if let p = $0 { free(p) } } }

    var pid: pid_t = 0
    let spawnRes = posix_spawn(&pid, exe, &fileActions, &attr, args, environ)
    close(pipeFds[1])

    guard spawnRes == 0 else {
        close(pipeFds[0])
        return nil
    }

    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 4096)
    while true {
        let n = read(pipeFds[0], &buffer, buffer.count)
        if n <= 0 { break }
        data.append(buffer, count: n)
    }
    close(pipeFds[0])

    var status: Int32 = 0
    waitpid(pid, &status, 0)

    guard let decoded = try? JSONDecoder().decode(MCPListEventsPayload.self, from: data),
          let items = decoded.items else {
        return nil
    }

    return items.map { ev in
        CalendarEventItem(
            id: ev.event_id ?? UUID().uuidString,
            title: ev.title ?? "Untitled Event",
            start: ev.start ?? "",
            end: ev.end ?? "",
            isAllDay: ev.all_day ?? false,
            calendarName: (ev.calendar_name ?? "Calendar").trimmingCharacters(in: .whitespaces),
            location: ev.location,
            notes: ev.notes
        )
    }
}

let calendar = Calendar.current
let now = Date()
let startOfToday = calendar.startOfDay(for: now)
let endOfWindow = calendar.date(byAdding: .day, value: 8, to: startOfToday) ?? now
let startIso = isoFormatter.string(from: startOfToday)
let endIso = isoFormatter.string(from: endOfWindow)

var calendarAuthorized = false
var remindersAuthorized = false
var eventItems: [CalendarEventItem] = []
var reminderItems: [ReminderItem] = []

// 1. Fetch Calendar events via signed MCP Helper BEFORE initializing EKEventStore
if let mcpEvents = fetchEventsViaMcpHelper(startIso: startIso, endIso: endIso), !mcpEvents.isEmpty {
    calendarAuthorized = true
    eventItems = mcpEvents
}

let store = EKEventStore()
let group = DispatchGroup()

if !calendarAuthorized {
    group.enter()
    if #available(macOS 14.0, *) {
        store.requestFullAccessToEvents { granted, _ in
            calendarAuthorized = granted
            if granted {
                let predicate = store.predicateForEvents(withStart: startOfToday, end: endOfWindow, calendars: nil)
                let rawEvents = store.events(matching: predicate)
                    .sorted { ($0.startDate ?? now) < ($1.startDate ?? now) }

                for ev in rawEvents.prefix(60) {
                    eventItems.append(CalendarEventItem(
                        id: ev.eventIdentifier ?? UUID().uuidString,
                        title: ev.title ?? "Untitled Event",
                        start: ev.startDate.map { isoFormatter.string(from: $0) } ?? "",
                        end: ev.endDate.map { isoFormatter.string(from: $0) } ?? "",
                        isAllDay: ev.isAllDay,
                        calendarName: (ev.calendar?.title ?? "Calendar").trimmingCharacters(in: .whitespaces),
                        location: ev.location,
                        notes: ev.notes
                    ))
                }
            }
            group.leave()
        }
    } else {
        store.requestAccess(to: .event) { granted, _ in
            calendarAuthorized = granted
            group.leave()
        }
    }
}

// 2. Fetch Reminders
group.enter()
if #available(macOS 14.0, *) {
    store.requestFullAccessToReminders { granted, _ in
        remindersAuthorized = granted
        if granted {
            let predicate = store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: nil)
            store.fetchReminders(matching: predicate) { rems in
                if let rems = rems {
                    let sorted = rems.sorted { ($0.creationDate ?? Date.distantPast) > ($1.creationDate ?? Date.distantPast) }
                    for r in sorted.prefix(25) {
                        let dueDateStr: String?
                        if let comps = r.dueDateComponents, let date = Calendar.current.date(from: comps) {
                            dueDateStr = isoFormatter.string(from: date)
                        } else {
                            dueDateStr = nil
                        }
                        let createdStr = r.creationDate.map { isoFormatter.string(from: $0) }

                        reminderItems.append(ReminderItem(
                            id: r.calendarItemIdentifier,
                            title: r.title ?? "Untitled Task",
                            isCompleted: r.isCompleted,
                            priority: r.priority,
                            listName: r.calendar?.title ?? "Reminders",
                            dueDate: dueDateStr,
                            creationDate: createdStr,
                            notes: r.notes
                        ))
                    }
                }
                group.leave()
            }
        } else {
            group.leave()
        }
    }
} else {
    store.requestAccess(to: .reminder) { granted, _ in
        remindersAuthorized = granted
        group.leave()
    }
}

let deadline = Date(timeIntervalSinceNow: 4.0)
while group.wait(timeout: .now()) == .timedOut && Date() < deadline {
    RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.05))
}

let payload = SchedulePayload(
    calendarAuthorized: calendarAuthorized,
    remindersAuthorized: remindersAuthorized,
    events: eventItems,
    reminders: reminderItems
)

let encoder = JSONEncoder()
if let data = try? encoder.encode(payload),
   let json = String(data: data, encoding: .utf8) {
    print(json)
} else {
    print("{\"calendarAuthorized\":false,\"remindersAuthorized\":false,\"events\":[],\"reminders\":[]}")
}
