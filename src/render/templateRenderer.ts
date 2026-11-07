import fs from 'fs';
import path from 'path';
import { getSchedule, ScheduleData, CalendarEvent, TaskItem } from '../collectors/tasksCollector';
import {
  getAgentTelemetry,
  AgentTelemetry,
  ActiveTaskFocus,
  TrendDay,
  ActivityHeatmap,
  ProviderBreakdown,
  DetectedAgent,
} from '../collectors/agentCollector';
import { getSystemHealth, SystemHealth, TopAppUsage } from '../collectors/systemCollector';
import { getAppleDevicesBattery, AppleDeviceBattery } from '../collectors/appleBatteryCollector';
import { getNowPlaying, NowPlayingTrack } from '../collectors/musicCollector';
import { getWeatherData, WeatherData } from '../collectors/weatherCollector';
import { timerManager, TimerState } from '../collectors/timerManager';
import { config } from '../config';
import { buildDemoDashboard } from './demoData';

export interface DashboardPayload {
  schedule: ScheduleData;
  agents: AgentTelemetry;
  system: SystemHealth;
  devices: AppleDeviceBattery[];
  music: NowPlayingTrack;
  weather: WeatherData;
  timer: TimerState;
  clock: {
    time: string;
    day: string;
    date: string;
  };
}

export async function gatherDashboardData(forceDemo: boolean = false): Promise<DashboardPayload> {
  // Screenshot / UI work mode: return fictional data instead of touching the
  // host's calendar, location, media and devices.
  if (forceDemo || process.env.DEMO_MODE === '1') {
    return buildDemoDashboard();
  }

  const [schedule, agents, system, devices, music, weather] = await Promise.all([
    getSchedule(),
    getAgentTelemetry(),
    getSystemHealth(),
    getAppleDevicesBattery(),
    getNowPlaying(),
    getWeatherData(),
  ]);

  const now = new Date();
  const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const day = now.toLocaleDateString('en-US', { weekday: 'long' });
  const date = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  return {
    schedule,
    agents,
    system,
    devices,
    music,
    weather,
    timer: timerManager.getState(),
    clock: { time, day, date },
  };
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatTokens(num: number): string {
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(0)}k`;
  return String(num);
}

function formatSeconds(secs: number): string {
  const m = Math.floor(Math.max(0, secs) / 60);
  const s = Math.floor(Math.max(0, secs) % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatMemoryMb(mb: number): string {
  if (mb >= 1024) {
    return `${(mb / 1024).toFixed(1)}GB`;
  }
  return `${Math.round(mb)}MB`;
}

function getDeviceIcon(type: AppleDeviceBattery['type']): string {
  switch (type) {
    case 'macbook':
      return '<span class="dev-type-badge">MAC</span>';
    case 'iphone':
      return '<span class="dev-type-badge">IPHONE</span>';
    case 'ipad':
      return '<span class="dev-type-badge">IPAD</span>';
    case 'watch':
      return '<span class="dev-type-badge">WATCH</span>';
    case 'keyboard':
      return '<span class="dev-type-badge">KBD</span>';
    case 'mouse':
    case 'trackpad':
      return '<span class="dev-type-badge">MOUSE</span>';
    case 'headphones':
      return '<span class="dev-type-badge">AUDIO</span>';
    default:
      return '<span class="dev-type-badge">DEV</span>';
  }
}

function renderDayProgressHtml(data: DashboardPayload): string {
  const [hourStr, minStr] = (data.clock.time || '11:25').split(':');
  const hour = parseInt(hourStr, 10) || 11;
  const min = parseInt(minStr, 10) || 25;
  const totalDayMins = (hour - 6) * 60 + min; // 06:00 to 22:00 (16h = 960m window)
  const dayPct = Math.max(4, Math.min(100, Math.round((totalDayMins / 960) * 100)));

  const timerStatus = data.timer.isRunning
    ? `FOCUS ACTIVE • ${escapeHtml(data.timer.timeFormatted)}`
    : `POMODORO READY • ${data.timer.completedPomodoros} DONE`;

  return `
    <div class="tab1-status-strip">
      <div class="status-strip-left">
        <span class="status-strip-tag">DAY TIMELINE (06:00–22:00)</span>
        <div class="day-timeline-track">
          <div class="day-timeline-fill" style="width: ${dayPct}%;"></div>
        </div>
        <span class="status-strip-pct">${dayPct}% ELAPSED</span>
      </div>
      <div class="status-strip-right">
        <span class="focus-pill">${timerStatus}</span>
      </div>
    </div>
  `;
}

function renderEventItem(ev: CalendarEvent, showDayPill: boolean, isFirstToday: boolean = false): string {
  const dayPill = showDayPill ? `<span class="event-day-pill">${escapeHtml(ev.dayLabel)}</span>` : '';
  const isFeatured = !showDayPill && (ev.status === 'NOW' || ev.status === 'NEXT' || isFirstToday);
  let statusBadge = '';
  if (!showDayPill && (ev.status === 'NOW' || ev.status === 'NEXT')) {
    const cls = ev.status === 'NOW' ? 'event-status-pill event-status-now' : 'event-status-pill event-status-next';
    statusBadge = `<span class="${cls}">${ev.status}</span>`;
  }

  const subParts: string[] = [];
  if (ev.location) subParts.push(`LOC: ${escapeHtml(ev.location)}`);
  if (ev.notes) subParts.push(escapeHtml(ev.notes));
  const subRow = subParts.length > 0 ? `<div class="event-sub-row">${subParts.join(' • ')}</div>` : '';
  const featuredClass = isFeatured ? ' event-item-featured' : '';

  return `
    <div class="event-item${featuredClass}">
      <div class="event-top-row">
        ${dayPill}
        <span class="event-time">${escapeHtml(ev.timeRange)}</span>
        ${statusBadge}
        <span class="event-title">${escapeHtml(ev.title)}</span>
        <span class="event-cal-tag">${escapeHtml(ev.calendarName)}</span>
      </div>
      ${subRow}
    </div>
  `;
}

function renderTaskItem(t: TaskItem): string {
  const urgentClass = t.priorityLabel === 'EXAM' || t.priorityLabel === 'HIGH' ? ' task-tag-urgent' : '';
  const dueBadge = t.dueLabel ? `<span class="task-due">${escapeHtml(t.dueLabel)}</span>` : '';
  const listOrPrio = t.priorityLabel || t.listName;
  const tagHtml = listOrPrio
    ? `<span class="task-tag${urgentClass}">${escapeHtml(listOrPrio)}</span>`
    : '';

  return `
    <div class="task-item">
      <div class="task-checkbox"></div>
      <span class="task-title">${escapeHtml(t.title)}</span>
      ${dueBadge}
      ${tagHtml}
    </div>
  `;
}

function renderTopAppRow(app: TopAppUsage, rank: number, primaryMetric: 'cpu' | 'mem'): string {
  const procStr = app.processCount > 1 ? `(${app.processCount}p)` : '';
  const barPct =
    primaryMetric === 'cpu'
      ? Math.min(100, Math.max(6, Math.round(app.cpuPercent * 2.5)))
      : Math.min(100, Math.max(6, Math.round((app.memoryMb / 1400) * 100)));
  const rightHtml =
    primaryMetric === 'cpu'
      ? `${app.cpuPercent.toFixed(1)}% CPU <span class="top-app-sub">• ${formatMemoryMb(app.memoryMb)}</span>`
      : `${formatMemoryMb(app.memoryMb)} <span class="top-app-sub">• ${app.cpuPercent.toFixed(1)}% CPU</span>`;

  return `
    <div class="top-app-row">
      <div class="top-app-left">
        <span class="top-app-rank">${rank}</span>
        <span class="top-app-name">${escapeHtml(app.name)}</span>
        <span class="top-app-procs">${procStr}</span>
      </div>
      <div class="top-app-bar-track">
        <div class="top-app-bar-fill" style="width: ${barPct}%;"></div>
      </div>
      <div class="top-app-right">${rightHtml}</div>
    </div>
  `;
}

function renderActiveTaskHtml(task?: ActiveTaskFocus): string {
  if (!task) {
    return `
      <div class="agent-focus-box agent-focus-idle">
        <div class="agent-focus-top">
          <div class="agent-focus-top-left">
            <span class="agent-status-badge badge-idle">● STANDBY</span>
            <span class="agent-focus-project">WORKSPACE READY</span>
          </div>
          <span class="agent-focus-model">FLEET STANDBY</span>
        </div>
        <div class="agent-focus-body">
          <span class="agent-focus-title">No active background tasks</span>
          <span class="agent-focus-sep">—</span>
          <span class="agent-focus-sub">Agents idle • Ready for prompt or code edit</span>
        </div>
      </div>
    `;
  }

  const isBusy = task.taskStatus === 'in_progress';
  const badgeClass = isBusy ? 'badge-busy' : 'badge-idle';
  const badgeText = isBusy ? '⚡ IN PROGRESS' : '● ACTIVE';
  const roleStr = task.agentRole ? ` • ${task.agentRole.toUpperCase()}` : '';

  return `
    <div class="agent-focus-box">
      <div class="agent-focus-top">
        <div class="agent-focus-top-left">
          <span class="agent-status-badge ${badgeClass}">${badgeText}</span>
          <span class="agent-focus-project">DIR: ${escapeHtml(task.projectName)}</span>
        </div>
        <span class="agent-focus-model">${escapeHtml(task.modelName)}${escapeHtml(roleStr)}</span>
      </div>
      <div class="agent-focus-body">
        <span class="agent-focus-title">${escapeHtml(task.sessionTitle)}</span>
        <span class="agent-focus-sep">—</span>
        <span class="agent-focus-sub">${escapeHtml(task.taskTitle)}</span>
      </div>
    </div>
  `;
}

function renderMcpBridgesHtml(bridges: string[]): string {
  if (!bridges || bridges.length === 0) {
    return '';
  }
  const tags = bridges
    .map(
      (b, idx) =>
        `<span class="mcp-bridge-pill"><span class="mcp-bridge-idx">${String(idx + 1).padStart(2, '0')}</span>${escapeHtml(b)}</span>`
    )
    .join('');
  return `
    <div class="mcp-bridges-row">
      <span class="mcp-bridges-label">MCP BUS (${bridges.length})</span>
      <div class="mcp-bridges-list">
        ${tags}
      </div>
    </div>
  `;
}

function renderTrendChartHtml(days: TrendDay[]): string {
  if (!days || days.length === 0) return '';

  const total7dTokens = days.reduce((sum, d) => sum + d.tokens, 0);
  const total7dCost = days.reduce((sum, d) => sum + d.cost, 0);
  const peakDay = days.reduce((best, d) => (d.tokens > best.tokens ? d : best), days[0]);

  const columns = days
    .map((d) => {
      const todayClass = d.isToday ? ' trend-col-today' : '';
      const barFillClass = d.isToday ? 'trend-bar-fill-today' : 'trend-bar-fill';
      const costStr = `$${d.cost.toFixed(2)}`;
      return `
        <div class="trend-col${todayClass}">
          <div class="trend-top-meta">
            <span class="trend-val">${escapeHtml(d.tokensFormatted)}</span>
            <span class="trend-cost">${costStr}</span>
          </div>
          <div class="trend-bar-track">
            <div class="${barFillClass}" style="height: ${d.heightPercent}%;"></div>
          </div>
          <span class="trend-label">${escapeHtml(d.dayLabel)}</span>
        </div>
      `;
    })
    .join('');

  return `
    <div class="trend-section">
      <div class="trend-header">
        <span class="trend-title">01 // 7-DAY TOKEN &amp; SPEND TREND</span>
        <span class="trend-sub">7D TOTAL: ${formatTokens(total7dTokens)} TOKENS &bull; $${total7dCost.toFixed(2)} SPEND &bull; PEAK: ${escapeHtml(peakDay.tokensFormatted)} (${escapeHtml(peakDay.shortDay.toUpperCase())})</span>
      </div>
      <div class="trend-chart-stage">
        <div class="trend-y-axis">
          <span>PEAK</span>
          <span>50%</span>
          <span>0</span>
        </div>
        <div class="trend-chart-wrap">
          <div class="trend-grid-line trend-grid-top"></div>
          <div class="trend-grid-line trend-grid-mid"></div>
          ${columns}
        </div>
      </div>
    </div>
  `;
}

function renderActivityHeatmapHtml(activity: ActivityHeatmap): string {
  if (!activity || !activity.weeks || activity.weeks.length === 0) return '';

  const weekHeaders = activity.weeks
    .map((_, idx) => `<span class="heatmap-week-lbl">W${String(idx + 1).padStart(2, '0')}</span>`)
    .join('');

  const weekCols = activity.weeks
    .map((w) => {
      const cells = w
        .map((c) => {
          return `<div class="heatmap-cell level-${c.level}"></div>`;
        })
        .join('');
      return `<div class="heatmap-col">${cells}</div>`;
    })
    .join('');

  const activeDaysStr = `${activity.totalActiveDays} / 70d`;
  const totalTokensStr = formatTokens(activity.totalTokens);
  const avgDailyTokens = formatTokens(Math.round(activity.totalTokens / 70));

  return `
    <div class="activity-section">
      <div class="activity-header">
        <span class="activity-title">02 // 10-WEEK ACTIVITY MATRIX (70-DAY DENSITY)</span>
        <span class="activity-stats">${activity.totalActiveDays}/70 ACTIVE DAYS &bull; ${totalTokensStr} TOTAL TOKENS &bull; ${avgDailyTokens}/DAY AVG</span>
      </div>
      <div class="activity-body">
        <div class="heatmap-matrix-area">
          <div class="heatmap-top-weeks">
            <span class="heatmap-corner-spacer"></span>
            <div class="heatmap-week-headers">${weekHeaders}</div>
          </div>
          <div class="heatmap-main-row">
            <div class="heatmap-days-legend">
              <span>MON</span>
              <span>TUE</span>
              <span>WED</span>
              <span>THU</span>
              <span>FRI</span>
              <span>SAT</span>
              <span>SUN</span>
            </div>
            <div class="heatmap-grid">
              ${weekCols}
            </div>
          </div>
        </div>
        <div class="heatmap-side-summary">
          <div class="heatmap-kpi-item">
            <span class="heatmap-kpi-lbl">ACTIVE DAYS</span>
            <span class="heatmap-kpi-val">${activeDaysStr}</span>
          </div>
          <div class="heatmap-kpi-item">
            <span class="heatmap-kpi-lbl">10W VOLUME</span>
            <span class="heatmap-kpi-val">${totalTokensStr}</span>
          </div>
          <div class="heatmap-kpi-item">
            <span class="heatmap-kpi-lbl">DAILY AVG</span>
            <span class="heatmap-kpi-val">${avgDailyTokens}</span>
          </div>
          <div class="heatmap-scale-row">
            <span class="legend-text">LESS</span>
            <div class="heatmap-legend-swatch level-0"></div>
            <div class="heatmap-legend-swatch level-1"></div>
            <div class="heatmap-legend-swatch level-2"></div>
            <div class="heatmap-legend-swatch level-3"></div>
            <span class="legend-text">MORE</span>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderProviderSplitHtml(p: ProviderBreakdown): string {
  if (!p) return '';
  const cPct = Math.max(0, p.claudePercent);
  const oPct = Math.max(0, p.openCodePercent);
  const otherPct = Math.max(0, 100 - cPct - oPct);

  return `
    <div class="provider-split-wrap">
      <div class="provider-bar-row">
        <span class="provider-bar-label">PROVIDER SHARE</span>
        <div class="provider-split-bar">
          <div class="provider-seg-claude" style="width: ${cPct}%;"></div>
          <div class="provider-seg-opencode" style="width: ${oPct}%;"></div>
          <div class="provider-seg-other" style="width: ${otherPct}%;"></div>
        </div>
      </div>
      <div class="provider-legend-row">
        <span class="provider-legend-item"><span class="legend-swatch swatch-claude"></span>Claude ${formatTokens(p.claudeTokens)} (${cPct}%)</span>
        <span class="provider-legend-item"><span class="legend-swatch swatch-opencode"></span>OpenCode ${formatTokens(p.openCodeTokens)} (${oPct}%)</span>
        <span class="provider-legend-item"><span class="legend-swatch swatch-other"></span>Antigravity / Local ${formatTokens(p.otherTokens)} (${otherPct}%)</span>
      </div>
    </div>
  `;
}

function renderCompactFleetHtml(agents: DetectedAgent[]): string {
  if (!agents || agents.length === 0) {
    return `<div class="empty-state">No active agent processes</div>`;
  }

  return agents
    .slice(0, 6)
    .map((a) => {
      const isBusy = a.status === 'busy';
      const statusPill = isBusy
        ? `<span class="agent-status-pill pill-busy">BUSY</span>`
        : `<span class="agent-status-pill pill-idle">IDLE</span>`;
      const procTag = a.processCount > 1 ? `${a.detail} • ${a.processCount}p` : a.detail;

      return `
        <div class="fleet-compact-row">
          <div class="fleet-compact-left">
            ${statusPill}
            <span class="fleet-compact-name">${escapeHtml(a.name)}</span>
            <span class="fleet-compact-tag">${escapeHtml(procTag)}</span>
          </div>
          <div class="fleet-compact-right">
            <span class="fleet-compact-meta">${a.cpuPercent}% • ${a.memoryMb}MB</span>
          </div>
        </div>
      `;
    })
    .join('');
}

function getTemplatePath(): string {
  const localPath = path.resolve(__dirname, 'views/dashboard.html');
  if (fs.existsSync(localPath)) return localPath;
  return path.resolve(__dirname, '../../src/render/views/dashboard.html');
}

const TAB_NAMES: Record<1 | 2 | 3, string> = {
  1: 'Schedule & Tasks',
  2: 'AI Agent Command',
  3: 'Media & System',
};

export function renderDashboardHtml(
  data: DashboardPayload,
  autoRefresh: boolean = false,
  activeTab: 1 | 2 | 3 = 1
): string {
  const templatePath = getTemplatePath();
  let html = fs.readFileSync(templatePath, 'utf8');

  // 0. Active Tab State
  html = html.replace(/{{ACTIVE_TAB}}/g, String(activeTab));
  html = html.replace('{{ACTIVE_TAB_NAME}}', TAB_NAMES[activeTab]);
  html = html.replace('{{TAB_1_ACTIVE_CLASS}}', activeTab === 1 ? 'tab-active' : '');
  html = html.replace('{{TAB_2_ACTIVE_CLASS}}', activeTab === 2 ? 'tab-active' : '');
  html = html.replace('{{TAB_3_ACTIVE_CLASS}}', activeTab === 3 ? 'tab-active' : '');
  html = html.replace('{{TAB_1_PANEL_CLASS}}', activeTab === 1 ? 'tab-panel-active' : '');
  html = html.replace('{{TAB_2_PANEL_CLASS}}', activeTab === 2 ? 'tab-panel-active' : '');
  html = html.replace('{{TAB_3_PANEL_CLASS}}', activeTab === 3 ? 'tab-panel-active' : '');

  // 1. Clock, Date & Host Uptime
  html = html.replace('{{CLOCK}}', data.clock.time);
  html = html.replace('{{DAY}}', data.clock.day);
  html = html.replace('{{DATE}}', data.clock.date);
  html = html.replace('{{UPTIME_HOURS}}', String(data.system.uptimeHours));
  html = html.replace(/{{CPU_CORES}}/g, String(data.system.cpuCores));
  if (autoRefresh) {
    html = html.replace('{{AUTO_REFRESH_SECONDS}}', String(config.refreshSeconds));
  } else {
    // A refresh of 0 would make headless Chrome reload forever and never
    // produce a screenshot, so drop the tag entirely for static renders.
    html = html.replace(/[ \t]*<meta http-equiv="refresh"[^>]*>\r?\n?/, '');
  }

  // 2. Weather
  html = html.replace('{{TEMP}}', `${data.weather.temperature}${data.weather.unit}`);
  html = html.replace('{{WEATHER_CITY}}', escapeHtml(data.weather.city));
  html = html.replace('{{WEATHER_COND}}', escapeHtml(data.weather.condition));
  html = html.replace('{{FEELS_LIKE}}', String(data.weather.feelsLike));
  html = html.replace('{{TEMP_MAX}}', `${data.weather.tempMax}°`);
  html = html.replace('{{TEMP_MIN}}', `${data.weather.tempMin}°`);
  html = html.replace('{{HUMIDITY}}', String(data.weather.humidity));
  html = html.replace('{{WIND_SPEED}}', String(data.weather.windSpeed));
  html = html.replace('{{PRECIP}}', String(data.weather.precipitationProbability));

  // 3. TAB 1: Today's Schedule & This Week's Schedule + Tasks
  html = html.replace('{{DAY_PROGRESS_HTML}}', renderDayProgressHtml(data));

  let todayEventsHtml = '';
  if (data.schedule.todayEvents.length === 0) {
    todayEventsHtml = '<div class="empty-state">No events scheduled for today</div>';
  } else {
    data.schedule.todayEvents.slice(0, 6).forEach((ev, idx) => {
      todayEventsHtml += renderEventItem(ev, false, idx === 0);
    });
  }
  html = html.replace('{{TODAY_EVENTS_HTML}}', todayEventsHtml);
  html = html.replace('{{TODAY_EVENT_COUNT}}', String(data.schedule.todayEvents.length));

  let weekEventsHtml = '';
  if (data.schedule.weekEvents.length === 0) {
    weekEventsHtml = '<div class="empty-state">No upcoming events in the next 7 days</div>';
  } else {
    for (const ev of data.schedule.weekEvents.slice(0, 6)) {
      weekEventsHtml += renderEventItem(ev, true);
    }
  }
  html = html.replace('{{WEEK_EVENTS_HTML}}', weekEventsHtml);
  html = html.replace('{{WEEK_EVENT_COUNT}}', String(data.schedule.weekEvents.length));

  let todayTasksHtml = '';
  if (data.schedule.todayTasks.length === 0) {
    todayTasksHtml = '<div class="empty-state">All clear for today!</div>';
  } else {
    for (const t of data.schedule.todayTasks.slice(0, 7)) {
      todayTasksHtml += renderTaskItem(t);
    }
  }
  html = html.replace('{{TODAY_TASKS_HTML}}', todayTasksHtml);
  html = html.replace('{{TODAY_TASK_COUNT}}', String(data.schedule.todayTasks.length));

  let weekTasksHtml = '';
  if (data.schedule.weekTasks.length === 0) {
    weekTasksHtml = '<div class="empty-state">No upcoming week tasks</div>';
  } else {
    for (const t of data.schedule.weekTasks.slice(0, 7)) {
      weekTasksHtml += renderTaskItem(t);
    }
  }
  html = html.replace('{{WEEK_TASKS_HTML}}', weekTasksHtml);
  html = html.replace('{{WEEK_TASK_COUNT}}', String(data.schedule.weekTasks.length));

  // 4. TAB 2 & TAB 3: Media + Active AI Agents
  html = html.replace('{{MUSIC_TITLE}}', escapeHtml(data.music.title));
  html = html.replace('{{MUSIC_ARTIST}}', escapeHtml(data.music.artist));
  const albumText = data.music.album ? `Album: ${escapeHtml(data.music.album)}` : 'Single / Stream';
  html = html.replace('{{MUSIC_ALBUM}}', albumText);
  html = html.replace(/{{MUSIC_SOURCE}}/g, escapeHtml(data.music.source));
  html = html.replace('{{MUSIC_STATUS}}', data.music.isPlaying ? '▶ PLAYING' : '⏸ PAUSED');
  html = html.replace(/{{MUSIC_PROGRESS}}/g, String(data.music.progressPercent));

  const elapsedStr = formatSeconds(data.music.elapsed);
  const durationStr = formatSeconds(data.music.duration);
  const remainingSecs = Math.max(0, data.music.duration - data.music.elapsed);
  const remainingStr = data.music.duration > 0 ? `-${formatSeconds(remainingSecs)}` : '0:00';
  html = html.replace(/{{MUSIC_ELAPSED}}/g, elapsedStr);
  html = html.replace(/{{MUSIC_DURATION}}/g, durationStr);
  html = html.replace('{{MUSIC_REMAINING}}', remainingStr);

  const artworkHtml = data.music.imageSrc
    ? `<div class="media-artwork-box"><img class="media-artwork-img" src="${escapeHtml(data.music.imageSrc)}" alt="Cover" /></div>`
    : `<div class="media-artwork-box"><svg class="media-artwork-svg" viewBox="0 0 100 100" width="100" height="100"><circle cx="50" cy="50" r="46" fill="#151515" stroke="#000" stroke-width="2"/><circle cx="50" cy="50" r="36" fill="none" stroke="#333" stroke-width="1.5"/><circle cx="50" cy="50" r="26" fill="none" stroke="#444" stroke-width="1.5"/><circle cx="50" cy="50" r="15" fill="#fff" stroke="#000" stroke-width="2"/><circle cx="50" cy="50" r="4" fill="#000"/></svg></div>`;
  html = html.replace('{{MUSIC_ARTWORK_HTML}}', artworkHtml);

  const compactFleetHtml = renderCompactFleetHtml(data.agents.agents);
  html = html.replace('{{AGENTS_HTML}}', compactFleetHtml);

  html = html.replace('{{ACTIVE_TASK_HTML}}', renderActiveTaskHtml(data.agents.activeTask));
  html = html.replace('{{TREND_CHART_HTML}}', renderTrendChartHtml(data.agents.trend7Days));
  html = html.replace('{{ACTIVITY_MAP_HTML}}', renderActivityHeatmapHtml(data.agents.activityMap));
  html = html.replace('{{PROVIDER_SPLIT_HTML}}', renderProviderSplitHtml(data.agents.providerBreakdown));
  html = html.replace('{{MCP_BRIDGES_HTML}}', renderMcpBridgesHtml(data.agents.mcpBridges));

  html = html.replace(/{{ACTIVE_AGENT_COUNT}}/g, String(data.agents.totalRunningAgents));
  html = html.replace(/{{ACTIVE_SESSIONS_COUNT}}/g, String(data.agents.claudeTokenStats.activeSessionsCount));
  html = html.replace('{{TODAY_TOKENS}}', formatTokens(data.agents.claudeTokenStats.todayTokens));
  html = html.replace('{{TODAY_COST}}', data.agents.claudeTokenStats.estimatedCostUsd.toFixed(2));
  html = html.replace('{{CACHE_HIT_RATE}}', String(data.agents.cacheEfficiency.hitRatePercent));
  html = html.replace('{{CACHED_TOKENS}}', formatTokens(data.agents.cacheEfficiency.cachedTokens));
  html = html.replace('{{PROMPT_TOKENS}}', formatTokens(data.agents.cacheEfficiency.promptTokens));
  html = html.replace('{{CACHE_SAVINGS}}', data.agents.cacheEfficiency.savingsUsd.toFixed(2));
  html = html.replace('{{TODAY_MESSAGES}}', String(data.agents.claudeTokenStats.todayMessages));
  html = html.replace('{{CLAUDE_CALLS}}', String(data.agents.claudeTokenStats.todayToolCalls));
  html = html.replace(/{{PRIMARY_MODEL}}/g, escapeHtml(data.agents.claudeTokenStats.primaryModel));

  // 5. TAB 3: System Health + Top Resource Apps + Apple Devices Battery
  html = html.replace(/{{CPU_PCT}}/g, String(data.system.cpuUsagePercent));
  html = html.replace('{{CPU_USER}}', String(data.system.cpuUserPercent));
  html = html.replace('{{CPU_SYS}}', String(data.system.cpuSysPercent));

  html = html.replace(/{{GPU_PCT}}/g, String(data.system.gpu.usagePercent));
  html = html.replace('{{GPU_CORES}}', String(data.system.gpu.cores));
  html = html.replace('{{GPU_RENDER}}', String(data.system.gpu.rendererPercent));
  html = html.replace('{{GPU_MEM}}', String(data.system.gpu.memoryUsedMb));
  html = html.replace('{{GPU_ALLOC}}', String(data.system.gpu.allocGb));

  html = html.replace(/{{RAM_PCT}}/g, String(data.system.memory.usedPercent));
  html = html.replace('{{RAM_USED}}', String(data.system.memory.usedGb));
  html = html.replace('{{RAM_TOTAL}}', String(data.system.memory.totalGb));
  html = html.replace('{{RAM_COMP}}', String(data.system.memory.compressedGb));

  html = html.replace(/{{DISK_PCT}}/g, String(data.system.disk.usedPercent));
  html = html.replace('{{DISK_USED}}', String(data.system.disk.usedGb));
  html = html.replace('{{DISK_TOTAL}}', String(data.system.disk.totalGb));
  html = html.replace('{{DISK_FREE}}', String(data.system.disk.freeGb));

  html = html.replace('{{LOAD_1M}}', String(data.system.loadAvg[0]));
  html = html.replace('{{LOAD_5M}}', String(data.system.loadAvg[1]));

  let topCpuHtml = '';
  const cpuApps = data.system.topCpuApps || [];
  if (cpuApps.length === 0) {
    topCpuHtml = '<div class="empty-state">No active CPU processes</div>';
  } else {
    cpuApps.slice(0, 5).forEach((app, idx) => {
      topCpuHtml += renderTopAppRow(app, idx + 1, 'cpu');
    });
  }
  html = html.replace('{{TOP_CPU_APPS_HTML}}', topCpuHtml);

  let topMemHtml = '';
  const memApps = data.system.topMemApps || [];
  if (memApps.length === 0) {
    topMemHtml = '<div class="empty-state">No active memory processes</div>';
  } else {
    memApps.slice(0, 5).forEach((app, idx) => {
      topMemHtml += renderTopAppRow(app, idx + 1, 'mem');
    });
  }
  html = html.replace('{{TOP_MEM_APPS_HTML}}', topMemHtml);

  let batteryHtml = '';
  for (const d of data.devices.slice(0, 6)) {
    const icon = getDeviceIcon(d.type);
    const barHtml = d.percent !== null
      ? `
        <div class="mini-progress-bar">
          <div class="mini-progress-fill" style="width: ${d.percent}%;"></div>
        </div>
      `
      : `
        <div class="mini-progress-bar mini-progress-standby">
          <div class="mini-progress-standby-fill"></div>
        </div>
      `;

    batteryHtml += `
      <div class="battery-card-item-lg">
        <div class="battery-item-top">
          <span class="battery-dev-name-lg">${icon} ${escapeHtml(d.name)}</span>
          <span class="battery-dev-pct-lg">${escapeHtml(d.statusText)}</span>
        </div>
        <div class="battery-item-sub">
          <span class="battery-dev-detail-lg">${escapeHtml(d.detail)}</span>
        </div>
        ${barHtml}
      </div>
    `;
  }
  html = html.replace('{{DEVICES_BATTERY_HTML}}', batteryHtml);
  html = html.replace('{{DEVICE_COUNT}}', String(data.devices.length));
  html = html.replace('{{LAST_SYNC}}', new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }));

  return html;
}
