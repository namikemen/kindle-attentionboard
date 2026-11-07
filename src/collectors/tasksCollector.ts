import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

const execAsync = promisify(exec);

export interface TaskItem {
  id: string;
  title: string;
  isCompleted: boolean;
  priority: number; // 0: None, 1: High, 5: Medium, 9: Low
  listName: string;
  dueDate: string | null;
  dueLabel: string;
  priorityLabel: string;
  source: 'reminder' | 'calendar-task';
}

export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  isAllDay: boolean;
  calendarName: string;
  timeRange: string;
  dayLabel: string;
  location: string;
  notes: string;
  status: 'NOW' | 'NEXT' | 'UPCOMING' | 'DONE' | 'ALL DAY';
}

export interface ScheduleData {
  tasks: TaskItem[];
  todayTasks: TaskItem[];
  weekTasks: TaskItem[];
  events: CalendarEvent[];
  todayEvents: CalendarEvent[];
  weekEvents: CalendarEvent[];
  lastUpdated: string;
}

let cachedSchedule: ScheduleData = {
  tasks: [],
  todayTasks: [],
  weekTasks: [],
  events: [],
  todayEvents: [],
  weekEvents: [],
  lastUpdated: new Date().toISOString(),
};

const TASK_CALENDARS = new Set(['todo', 'test', 'scheduled reminders']);

function resolveTasksHelperPath(): string {
  const p1 = path.resolve(__dirname, '../../bin/tasks-helper');
  if (fs.existsSync(p1)) return p1;
  const p2 = path.resolve(__dirname, '../bin/tasks-helper');
  if (fs.existsSync(p2)) return p2;
  return path.resolve(process.cwd(), 'bin/tasks-helper');
}

function formatTime(isoString: string): string {
  if (!isoString) return '';
  try {
    const d = new Date(isoString);
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
  } catch {
    return '';
  }
}

function formatDayShort(isoString: string): string {
  if (!isoString) return '';
  try {
    const d = new Date(isoString);
    const weekday = d.toLocaleDateString('en-US', { weekday: 'short' });
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    return `${weekday} ${day}/${month}`;
  } catch {
    return '';
  }
}

function cleanLocation(loc?: string | null): string {
  if (!loc) return '';
  const trimmed = loc.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) {
    return '';
  }
  return trimmed.split('\n')[0].slice(0, 42);
}

function cleanNotes(notes?: string | null): string {
  if (!notes) return '';
  const firstLine = notes
    .split(/\\n|\n/)
    .map((s) => s.trim())
    .find((s) => s.length > 0 && !s.startsWith('http'));
  return firstLine ? firstLine.slice(0, 48) : '';
}

function getPriorityLabel(prio: number): string {
  if (prio >= 1 && prio <= 4) return 'HIGH';
  if (prio === 5) return 'MED';
  if (prio >= 6 && prio <= 9) return 'LOW';
  return '';
}

function isSameLocalDay(d1: Date, d2: Date): boolean {
  return (
    d1.getFullYear() === d2.getFullYear() &&
    d1.getMonth() === d2.getMonth() &&
    d1.getDate() === d2.getDate()
  );
}

export async function getSchedule(): Promise<ScheduleData> {
  const binaryPath = resolveTasksHelperPath();

  if (fs.existsSync(binaryPath)) {
    try {
      const { stdout } = await execAsync(`"${binaryPath}"`, { timeout: 6000 });
      const raw = JSON.parse(stdout.trim());

      const now = new Date();
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
      const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
      const endOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7, 23, 59, 59, 999);

      // 1. Parse all raw Reminders
      const rawReminders: TaskItem[] = (raw.reminders || []).map((r: {
        id: string;
        title: string;
        isCompleted: boolean;
        priority: number;
        listName: string;
        dueDate: string | null;
      }) => {
        let dueLabel = '';
        if (r.dueDate) {
          const due = new Date(r.dueDate);
          if (isSameLocalDay(due, now)) {
            dueLabel = `Today ${formatTime(r.dueDate)}`;
          } else {
            dueLabel = formatDayShort(r.dueDate);
          }
        }
        return {
          id: r.id,
          title: r.title,
          isCompleted: Boolean(r.isCompleted),
          priority: r.priority || 0,
          listName: (r.listName || 'Reminders').trim(),
          dueDate: r.dueDate || null,
          dueLabel,
          priorityLabel: getPriorityLabel(r.priority || 0),
          source: 'reminder' as const,
        };
      });

      // 2. Parse all raw Calendar Events (Today + 7 days)
      const allEvents: CalendarEvent[] = [];
      const calendarTasksToday: TaskItem[] = [];
      const calendarTasksWeek: TaskItem[] = [];

      for (const e of raw.events || []) {
        const startDate = new Date(e.start);
        const endDate = new Date(e.end);
        const calName = (e.calendarName || 'Calendar').trim();
        const calLower = calName.toLowerCase();
        const isAllDay = Boolean(e.isAllDay);
        const startFormatted = formatTime(e.start);
        const endFormatted = formatTime(e.end);
        const timeRange = isAllDay ? 'All Day' : `${startFormatted}-${endFormatted}`;
        const dayLabel = isSameLocalDay(startDate, now) ? 'Today' : formatDayShort(e.start);

        let status: CalendarEvent['status'] = 'UPCOMING';
        if (isAllDay) {
          status = 'ALL DAY';
        } else if (now >= startDate && now <= endDate) {
          status = 'NOW';
        } else if (now > endDate) {
          status = 'DONE';
        }

        const eventObj: CalendarEvent = {
          id: e.id,
          title: e.title,
          start: e.start,
          end: e.end,
          isAllDay,
          calendarName: calName,
          timeRange,
          dayLabel,
          location: cleanLocation(e.location),
          notes: cleanNotes(e.notes),
          status,
        };

        allEvents.push(eventObj);

        // Also surface Todo / Test / Deadline calendar items into Today/Week Tasks
        if (TASK_CALENDARS.has(calLower)) {
          const taskObj: TaskItem = {
            id: `cal-${e.id}-${e.start}`,
            title: e.title,
            isCompleted: false,
            priority: calLower === 'test' ? 1 : 5,
            listName: calName.toUpperCase(),
            dueDate: e.start,
            dueLabel: isSameLocalDay(startDate, now)
              ? (isAllDay ? 'Today' : `Today ${startFormatted}`)
              : `${formatDayShort(e.start)}${isAllDay ? '' : ' ' + startFormatted}`,
            priorityLabel: calLower === 'test' ? 'EXAM' : 'DUE',
            source: 'calendar-task',
          };

          if (startDate <= endOfToday && endDate >= startOfToday) {
            calendarTasksToday.push(taskObj);
          } else if (startDate > endOfToday && startDate <= endOfWeek) {
            calendarTasksWeek.push(taskObj);
          }
        }
      }

      // Today's Schedule Events (all events overlapping today, sorted: timed active/upcoming first, then all-day, then done)
      const todayEvents = allEvents
        .filter((ev) => {
          const s = new Date(ev.start);
          const e = new Date(ev.end);
          return s <= endOfToday && e >= startOfToday;
        })
        .sort((a, b) => {
          if (a.isAllDay !== b.isAllDay) return a.isAllDay ? 1 : -1;
          return new Date(a.start).getTime() - new Date(b.start).getTime();
        });

      // Mark the first upcoming timed event today as NEXT if none is NOW
      const firstUpcoming = todayEvents.find((ev) => !ev.isAllDay && ev.status === 'UPCOMING');
      if (firstUpcoming) {
        firstUpcoming.status = 'NEXT';
      }

      // Upcoming Week Schedule Events (from tomorrow through +7 days, excluding noisy daily recurring personal reminders if needed, or keeping all sorted)
      const weekEvents = allEvents
        .filter((ev) => {
          const s = new Date(ev.start);
          return s > endOfToday && s <= endOfWeek;
        })
        .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

      // Today's Tasks:
      // 1) Calendar Todo/Test items due today
      // 2) Reminders due today or overdue
      // 3) High-priority or "Todo" list reminders so Today's Tasks is always actionable
      const dueTodayReminders = rawReminders.filter((r) => {
        if (!r.dueDate) return false;
        const d = new Date(r.dueDate);
        return d <= endOfToday;
      });

      const todoListReminders = rawReminders.filter(
        (r) =>
          !dueTodayReminders.some((d) => d.id === r.id) &&
          (r.listName.toLowerCase() === 'todo' || r.priority === 1)
      );

      const todayTasks: TaskItem[] = [
        ...calendarTasksToday,
        ...dueTodayReminders,
        ...todoListReminders,
      ];

      // This Week's Tasks:
      // 1) Calendar Todo/Test items due in the next 7 days
      // 2) Reminders due in the next 7 days (or upcoming)
      // 3) Remaining active reminders from other lists (Nhắc nhở, Stuff, Groceries, 暇)
      const usedTodayIds = new Set(todayTasks.map((t) => t.id));
      const dueWeekReminders = rawReminders.filter((r) => {
        if (usedTodayIds.has(r.id)) return false;
        if (!r.dueDate) return false;
        const d = new Date(r.dueDate);
        return d > endOfToday && d <= endOfWeek;
      });

      const otherActiveReminders = rawReminders.filter(
        (r) => !usedTodayIds.has(r.id) && !dueWeekReminders.some((w) => w.id === r.id)
      );

      const weekTasks: TaskItem[] = [
        ...calendarTasksWeek,
        ...dueWeekReminders,
        ...otherActiveReminders,
      ];

      cachedSchedule = {
        tasks: rawReminders,
        todayTasks,
        weekTasks,
        events: todayEvents,
        todayEvents,
        weekEvents,
        lastUpdated: new Date().toISOString(),
      };
      return cachedSchedule;
    } catch {
      // Return cached on error
    }
  }

  return cachedSchedule;
}
