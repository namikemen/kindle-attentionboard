import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { calculateTokenCost } from '../logic/costEstimator';

const execAsync = promisify(exec);

export interface DetectedAgent {
  name: string;
  category: 'antigravity' | 'claude' | 'copilot' | 'codex' | 'zed' | 'cursor' | 'opencode' | 'mcp' | 'other';
  pid: number;
  cpuPercent: number;
  memoryMb: number;
  processCount: number;
  detail: string;
  status: 'running' | 'busy' | 'idle';
  commandPreview: string;
}

export interface ActiveTaskFocus {
  sessionTitle: string;
  projectName: string;
  taskTitle: string;
  taskStatus: 'in_progress' | 'pending' | 'completed' | 'idle';
  modelName: string;
  agentRole: string;
}

export interface TrendDay {
  date: string;
  dayLabel: string;
  shortDay: string;
  tokens: number;
  cost: number;
  tokensFormatted: string;
  heightPercent: number;
  isToday: boolean;
}

export interface ActivityCell {
  date: string;
  tokens: number;
  level: 0 | 1 | 2 | 3;
}

export interface ActivityHeatmap {
  weeks: ActivityCell[][];
  totalActiveDays: number;
  totalTokens: number;
}

export interface ProviderBreakdown {
  claudePercent: number;
  openCodePercent: number;
  otherPercent: number;
  claudeTokens: number;
  openCodeTokens: number;
  otherTokens: number;
}

export interface AgentTelemetry {
  totalRunningAgents: number;
  agents: DetectedAgent[];
  activeTask?: ActiveTaskFocus;
  mcpBridges: string[];
  cacheEfficiency: {
    hitRatePercent: number;
    savingsUsd: number;
    cachedTokens: number;
    promptTokens: number;
  };
  providerBreakdown: ProviderBreakdown;
  trend7Days: TrendDay[];
  activityMap: ActivityHeatmap;
  claudeTokenStats: {
    todayTokens: number;
    todayMessages: number;
    todayToolCalls: number;
    activeSessionsCount: number;
    primaryModel: string;
    estimatedCostUsd: number;
  };
}

const AGENT_SIGNATURES: Array<{
  pattern: RegExp;
  name: string;
  category: DetectedAgent['category'];
  defaultDetail: string;
}> = [
  {
    pattern: /Antigravity\.app|override_ide_name\s+antigravity|\/bin\/agy\b/i,
    name: 'Google Antigravity',
    category: 'antigravity',
    defaultDetail: 'IDE + Agent Hub',
  },
  {
    pattern: /\/Applications\/OpenCode\.app/i,
    name: 'OpenCode IDE',
    category: 'opencode',
    defaultDetail: 'AI Editor',
  },
  {
    pattern: /opencode-cli\s+serve|opencode-pty|opencode\s+daemon/i,
    name: 'OpenCode Service',
    category: 'opencode',
    defaultDetail: 'Daemon & Tools',
  },
  {
    pattern: /claude-code\/.*\/claude\.app\/Contents\/MacOS\/claude|(?:^|\s|\/)claude\s+--/i,
    name: 'Claude Code CLI',
    category: 'claude',
    defaultDetail: 'Agent Session',
  },
  {
    pattern: /\/Applications\/Claude\.app\/Contents\/(?:MacOS\/Claude|Frameworks\/Claude Helper)/i,
    name: 'Claude Desktop',
    category: 'claude',
    defaultDetail: 'Desktop App',
  },
  {
    pattern: /copilot-runtime|copilot-agent|copilot-language-server|github\.copilot/i,
    name: 'GitHub Copilot',
    category: 'copilot',
    defaultDetail: 'VS Code SDK',
  },
  {
    pattern: /\/Applications\/Cursor\.app|cursor-agent/i,
    name: 'Cursor AI',
    category: 'cursor',
    defaultDetail: 'AI Editor',
  },
  {
    pattern: /\/Applications\/Windsurf\.app|codeium/i,
    name: 'Windsurf AI',
    category: 'other',
    defaultDetail: 'AI Editor',
  },
  {
    pattern: /(?:^|\s|\/)codex\b|ChatGPT\.app/i,
    name: 'OpenAI Codex / GPT',
    category: 'codex',
    defaultDetail: 'OpenAI',
  },
  {
    pattern: /\/Applications\/Zed\.app|zcode\b/i,
    name: 'Zed AI',
    category: 'zed',
    defaultDetail: 'AI Editor',
  },
  {
    pattern: /\/Applications\/AionUi\.app|ollama\b|LM Studio|aider\b|cline\b/i,
    name: 'Local / CLI AI',
    category: 'other',
    defaultDetail: 'Local Runtime',
  },
  {
    pattern: /chrome-devtools-mcp|apple-tools-mcp|mcp-remote|code-review-graph|biomolecular_structure_viewer_mcp|@playwright\/mcp/i,
    name: 'MCP Tool Servers',
    category: 'mcp',
    defaultDetail: 'Active Bridges',
  },
];

const MCP_BRIDGE_SIGNATURES: Array<{ pattern: RegExp; name: string }> = [
  { pattern: /apple-tools-mcp/i, name: 'Apple Tools' },
  { pattern: /chrome-devtools-mcp/i, name: 'Chrome DevTools' },
  { pattern: /@playwright\/mcp|playwright-mcp/i, name: 'Playwright' },
  { pattern: /mcp-remote.*kaggle\.com/i, name: 'Kaggle Remote' },
  { pattern: /mcp-remote/i, name: 'MCP Remote' },
  { pattern: /telegram.*mcp|mcp.*telegram/i, name: 'Telegram' },
  { pattern: /code-review-graph/i, name: 'Code Review Graph' },
  { pattern: /biomolecular_structure_viewer_mcp/i, name: 'Biomol Viewer' },
  { pattern: /filesystem.*mcp|mcp-server-filesystem/i, name: 'Filesystem' },
  { pattern: /sqlite.*mcp|mcp-server-sqlite/i, name: 'SQLite' },
  { pattern: /context7/i, name: 'Context7' },
  { pattern: /gh_grep|github-grep/i, name: 'GitHub Grep' },
];

function getTodayString(offsetDays: number = 0): string {
  const d = new Date();
  if (offsetDays !== 0) d.setDate(d.getDate() + offsetDays);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getStartOfTodayMs(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function formatTokensCompact(n: number): string {
  if (n <= 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function parseClaudeStatsCache(today: string): {
  todayTokens: number;
  todayMessages: number;
  todayToolCalls: number;
  primaryModel: string;
  estimatedCostUsd: number;
  cacheTokens: number;
  promptTokens: number;
  historyMap: Map<string, { tokens: number; cost: number }>;
} {
  const historyMap = new Map<string, { tokens: number; cost: number }>();
  const defaultStats = {
    todayTokens: 0,
    todayMessages: 0,
    todayToolCalls: 0,
    primaryModel: 'claude-sonnet',
    estimatedCostUsd: 0,
    cacheTokens: 0,
    promptTokens: 0,
    historyMap,
  };

  const cachePath = path.join(os.homedir(), '.claude/stats-cache.json');
  if (!fs.existsSync(cachePath)) {
    return defaultStats;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));

    let todayTokens = 0;
    let todayMessages = 0;
    let todayToolCalls = 0;

    if (Array.isArray(raw.dailyActivity)) {
      const todayActivity = raw.dailyActivity.find((item: { date: string }) => item.date === today);
      if (todayActivity) {
        todayMessages = todayActivity.messageCount || 0;
        todayToolCalls = todayActivity.toolCallCount || 0;
      }
    }

    if (Array.isArray(raw.dailyModelTokens)) {
      for (const item of raw.dailyModelTokens) {
        if (!item || typeof item !== 'object') continue;
        let dayTokens = 0;
        for (const [key, val] of Object.entries(item)) {
          if (key !== 'date' && typeof val === 'number') {
            dayTokens += val;
          }
        }
        if (item.date && typeof item.date === 'string' && dayTokens > 0) {
          historyMap.set(item.date, {
            tokens: dayTokens,
            cost: (dayTokens / 1_000_000) * 3.0,
          });
          if (item.date === today) {
            todayTokens = dayTokens;
          }
        }
      }
    }

    let primaryModel = 'claude-sonnet';
    if (raw.modelUsage && typeof raw.modelUsage === 'object') {
      const models = Object.keys(raw.modelUsage);
      if (models.length > 0) {
        primaryModel = models[models.length - 1];
      }
    }

    const cacheTokens = Math.round(todayTokens * 0.7);
    const promptTokens = Math.round(todayTokens * 0.85);

    const costResult = calculateTokenCost({
      inputTokens: Math.max(0, promptTokens - cacheTokens),
      outputTokens: Math.round(todayTokens * 0.15),
      cacheReadTokens: cacheTokens,
      cacheWriteTokens: 0,
      modelName: primaryModel,
    });

    return {
      todayTokens,
      todayMessages,
      todayToolCalls,
      primaryModel,
      estimatedCostUsd: costResult.estimatedCostUsd,
      cacheTokens,
      promptTokens,
      historyMap,
    };
  } catch {
    return defaultStats;
  }
}

async function parseOpenCodeData(startOfTodayMs: number): Promise<{
  todayTokens: number;
  todayMessages: number;
  todayToolCalls: number;
  estimatedCostUsd: number;
  cacheTokens: number;
  promptTokens: number;
  activeTask?: ActiveTaskFocus;
  primaryModel?: string;
  historyMap: Map<string, { tokens: number; cost: number }>;
}> {
  const historyMap = new Map<string, { tokens: number; cost: number }>();
  const result = {
    todayTokens: 0,
    todayMessages: 0,
    todayToolCalls: 0,
    estimatedCostUsd: 0,
    cacheTokens: 0,
    promptTokens: 0,
    activeTask: undefined as ActiveTaskFocus | undefined,
    primaryModel: undefined as string | undefined,
    historyMap,
  };

  const dbPath = path.join(os.homedir(), '.local/share/opencode/opencode.db');
  if (!fs.existsSync(dbPath)) {
    return result;
  }

  try {
    const query = `
      SELECT 
        count(*),
        COALESCE(sum(json_extract(data, '$.tokens.input') + json_extract(data, '$.tokens.output') + json_extract(data, '$.tokens.cache.read')), 0),
        COALESCE(sum(json_extract(data, '$.cost')), 0),
        COALESCE(sum(json_extract(data, '$.tokens.cache.read')), 0),
        COALESCE(sum(json_extract(data, '$.tokens.input') + json_extract(data, '$.tokens.cache.read')), 0)
      FROM message
      WHERE time_created >= ${startOfTodayMs};
      SELECT count(*)
      FROM part
      WHERE json_extract(data, '$.type') = 'tool' AND time_created >= ${startOfTodayMs};
      SELECT t.content, t.status, s.title, s.directory, s.model, s.agent
      FROM todo t
      JOIN session s ON t.session_id = s.id
      WHERE t.status = 'in_progress'
      ORDER BY t.time_updated DESC
      LIMIT 1;
      SELECT s.id, s.title, s.directory, s.agent, s.model, s.time_updated
      FROM session s
      ORDER BY s.time_updated DESC
      LIMIT 1;
      SELECT 
        date(time_created / 1000, 'unixepoch', 'localtime') AS day,
        COALESCE(sum(json_extract(data, '$.tokens.input') + json_extract(data, '$.tokens.output') + json_extract(data, '$.tokens.cache.read')), 0),
        COALESCE(sum(json_extract(data, '$.cost')), 0)
      FROM message
      GROUP BY 1
      ORDER BY 1 DESC
      LIMIT 90;
    `;

    const { stdout } = await execAsync(`sqlite3 "file:${dbPath}?mode=ro" "${query.replace(/\n\s+/g, ' ')}"`, {
      timeout: 2500,
    });

    const lines = stdout.trim().split('\n').map((l) => l.trim());
    if (lines.length >= 2) {
      const statsParts = lines[0].split('|');
      result.todayMessages = parseInt(statsParts[0], 10) || 0;
      result.todayTokens = Math.round(parseFloat(statsParts[1]) || 0);
      result.estimatedCostUsd = parseFloat((parseFloat(statsParts[2]) || 0).toFixed(2));
      result.cacheTokens = Math.round(parseFloat(statsParts[3]) || 0);
      result.promptTokens = Math.round(parseFloat(statsParts[4]) || 0);

      result.todayToolCalls = parseInt(lines[1], 10) || 0;
    }

    // Line 3: in_progress task (if any)
    if (lines.length >= 3 && lines[2]) {
      const parts = lines[2].split('|');
      if (parts.length >= 4) {
        const content = parts[0];
        const status = parts[1] as 'in_progress' | 'pending';
        const sessionTitle = parts[2] || 'Active Session';
        const directory = parts[3] || 'Workspace';
        let modelName = 'opencode';
        let agentRole = parts[5] || 'agent';

        try {
          const modelObj = JSON.parse(parts[4]);
          if (modelObj && modelObj.id) modelName = modelObj.id;
        } catch {
          if (parts[4]) modelName = parts[4];
        }

        result.activeTask = {
          sessionTitle,
          projectName: path.basename(directory),
          taskTitle: content,
          taskStatus: status,
          modelName,
          agentRole,
        };
        result.primaryModel = modelName;
      }
    }

    // Line 4: latest session (fallback if no active in_progress task)
    if (!result.activeTask && lines.length >= 4 && lines[3]) {
      const parts = lines[3].split('|');
      if (parts.length >= 3) {
        const sessionTitle = parts[1] || 'Standby';
        const directory = parts[2] || 'Workspace';
        const agentRole = parts[3] || 'agent';
        let modelName = 'opencode';

        try {
          const modelObj = JSON.parse(parts[4]);
          if (modelObj && modelObj.id) modelName = modelObj.id;
        } catch {
          if (parts[4]) modelName = parts[4];
        }

        result.activeTask = {
          sessionTitle,
          projectName: path.basename(directory),
          taskTitle: 'Session ready for prompt',
          taskStatus: 'idle',
          modelName,
          agentRole,
        };
        result.primaryModel = modelName;
      }
    }

    // Line 5+: historical days
    for (let i = 4; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const parts = line.split('|');
      if (parts.length >= 3) {
        const day = parts[0];
        const tokens = Math.round(parseFloat(parts[1]) || 0);
        const cost = parseFloat(parts[2]) || 0;
        if (day && tokens > 0) {
          historyMap.set(day, { tokens, cost });
        }
      }
    }
  } catch {
    // OpenCode SQLite reading fallback
  }

  return result;
}

function buildTrend7Days(
  todayStr: string,
  historyMap: Map<string, { tokens: number; cost: number }>,
  todayTokens: number,
  todayCost: number
): TrendDay[] {
  const days: TrendDay[] = [];
  const now = new Date();

  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const dateStr = `${year}-${month}-${day}`;
    const shortDay = d.toLocaleDateString('en-US', { weekday: 'short' });
    const isToday = i === 0;

    let tokens = 0;
    let cost = 0;

    if (isToday) {
      tokens = todayTokens;
      cost = todayCost;
    } else {
      const entry = historyMap.get(dateStr);
      if (entry) {
        tokens = entry.tokens;
        cost = entry.cost;
      }
    }

    days.push({
      date: dateStr,
      dayLabel: isToday ? 'TODAY' : `${shortDay} ${day}`,
      shortDay,
      tokens,
      cost,
      tokensFormatted: formatTokensCompact(tokens),
      heightPercent: 0,
      isToday,
    });
  }

  const peak = Math.max(...days.map((d) => d.tokens), 10_000);
  for (const d of days) {
    d.heightPercent = d.tokens > 0 ? Math.min(100, Math.max(8, Math.round((d.tokens / peak) * 100))) : 4;
  }

  return days;
}

function buildActivityHeatmap(
  historyMap: Map<string, { tokens: number; cost: number }>,
  todayStr: string,
  todayTokens: number
): ActivityHeatmap {
  const weeks: ActivityCell[][] = [];
  const now = new Date();

  // Find the end of current week (Sunday)
  const currentDayOfWeek = now.getDay(); // 0 is Sun, 1 is Mon...
  const daysUntilSunday = currentDayOfWeek === 0 ? 0 : 7 - currentDayOfWeek;
  const endSunday = new Date(now);
  endSunday.setDate(endSunday.getDate() + daysUntilSunday);

  const totalDays = 70; // 10 weeks
  const startDate = new Date(endSunday);
  startDate.setDate(startDate.getDate() - totalDays + 1);

  let activeDays = 0;
  let totalTokens = 0;

  for (let w = 0; w < 10; w++) {
    const weekCells: ActivityCell[] = [];
    for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
      const cellDate = new Date(startDate);
      cellDate.setDate(cellDate.getDate() + w * 7 + dayIdx);

      const year = cellDate.getFullYear();
      const month = String(cellDate.getMonth() + 1).padStart(2, '0');
      const day = String(cellDate.getDate()).padStart(2, '0');
      const dateStr = `${year}-${month}-${day}`;

      let tokens = 0;
      if (dateStr === todayStr) {
        tokens = todayTokens;
      } else {
        tokens = historyMap.get(dateStr)?.tokens || 0;
      }

      let level: 0 | 1 | 2 | 3 = 0;
      if (tokens > 250_000) level = 3;
      else if (tokens > 50_000) level = 2;
      else if (tokens > 0) level = 1;

      if (tokens > 0) activeDays += 1;
      totalTokens += tokens;

      weekCells.push({
        date: dateStr,
        tokens,
        level,
      });
    }
    weeks.push(weekCells);
  }

  return {
    weeks,
    totalActiveDays: activeDays,
    totalTokens,
  };
}

export async function getAgentTelemetry(): Promise<AgentTelemetry> {
  const detectedAgents: DetectedAgent[] = [];
  const activeMcpBridges = new Set<string>();

  try {
    const { stdout } = await execAsync('ps -eo pid,%cpu,rss,command', { timeout: 3000 });
    const lines = stdout.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('PID')) continue;

      const parts = trimmed.split(/\s+/);
      if (parts.length < 4) continue;

      const pid = parseInt(parts[0], 10);
      const cpu = parseFloat(parts[1]) || 0;
      const rssKb = parseInt(parts[2], 10) || 0;
      const cmd = parts.slice(3).join(' ');

      if (
        cmd.includes('grep') ||
        cmd.includes('ps -eo') ||
        cmd.includes('Contents/Helpers/disclaimer') ||
        cmd.includes('watchdog/main.js')
      ) {
        continue;
      }

      for (const mcpSig of MCP_BRIDGE_SIGNATURES) {
        if (mcpSig.pattern.test(cmd)) {
          activeMcpBridges.add(mcpSig.name);
        }
      }

      for (const sig of AGENT_SIGNATURES) {
        if (sig.pattern.test(cmd)) {
          const rssMb = Math.round(rssKb / 1024);
          let extractedDetail = '';

          const modelMatch = cmd.match(/--model[=\s]+([^\s"]+)/);
          if (modelMatch) {
            extractedDetail = modelMatch[1].replace(/\[.*\]/, '');
          } else if (sig.category === 'antigravity' && cmd.includes('--override_ide_version')) {
            const verMatch = cmd.match(/--override_ide_version\s+([^\s]+)/);
            if (verMatch) extractedDetail = `v${verMatch[1]}`;
          }

          const existing = detectedAgents.find((a) => a.name === sig.name);
          if (existing) {
            existing.cpuPercent = parseFloat((existing.cpuPercent + cpu).toFixed(1));
            existing.memoryMb += rssMb;
            existing.processCount += 1;
            if (extractedDetail && existing.detail === sig.defaultDetail) {
              existing.detail = extractedDetail;
            }
            if (existing.cpuPercent > 5.0) existing.status = 'busy';
          } else {
            detectedAgents.push({
              name: sig.name,
              category: sig.category,
              pid,
              cpuPercent: parseFloat(cpu.toFixed(1)),
              memoryMb: rssMb,
              processCount: 1,
              detail: extractedDetail || sig.defaultDetail,
              status: cpu > 5.0 ? 'busy' : 'running',
              commandPreview: cmd.slice(0, 60),
            });
          }
          break;
        }
      }
    }
  } catch {
    // Process list failure fallback
  }

  const mcpAgent = detectedAgents.find((a) => a.category === 'mcp');
  if (mcpAgent && activeMcpBridges.size > 0) {
    mcpAgent.detail = `${activeMcpBridges.size} Active (${Array.from(activeMcpBridges).slice(0, 2).join(', ')})`;
  }

  detectedAgents.sort((a, b) => {
    if (a.status === 'busy' && b.status !== 'busy') return -1;
    if (b.status === 'busy' && a.status !== 'busy') return 1;
    if (a.category === 'mcp' && b.category !== 'mcp') return 1;
    if (b.category === 'mcp' && a.category !== 'mcp') return -1;
    return b.cpuPercent - a.cpuPercent || b.memoryMb - a.memoryMb;
  });

  const todayStr = getTodayString();
  const startOfTodayMs = getStartOfTodayMs();

  const claudeStats = parseClaudeStatsCache(todayStr);
  const openCodeData = await parseOpenCodeData(startOfTodayMs);

  let activeTask = openCodeData.activeTask;

  const claudeCli = detectedAgents.find((a) => a.name === 'Claude Code CLI');
  if (claudeCli) {
    if (claudeCli.detail && claudeCli.detail !== 'Agent Session') {
      claudeStats.primaryModel = claudeCli.detail;
    }
    if (claudeCli.status === 'busy' && (!activeTask || activeTask.taskStatus !== 'in_progress')) {
      activeTask = {
        sessionTitle: 'Claude Code CLI Session',
        projectName: 'Workspace',
        taskTitle: 'Autonomous agent execution in progress',
        taskStatus: 'in_progress',
        modelName: claudeCli.detail || 'claude-opus-5',
        agentRole: 'claude',
      };
    }
  }

  const primaryModel =
    claudeCli?.detail && claudeCli.detail !== 'Agent Session'
      ? claudeCli.detail
      : openCodeData.primaryModel || claudeStats.primaryModel;

  const totalTokens = claudeStats.todayTokens + openCodeData.todayTokens;
  const totalMessages = claudeStats.todayMessages + openCodeData.todayMessages;
  const totalToolCalls = claudeStats.todayToolCalls + openCodeData.todayToolCalls;
  const totalCost = parseFloat((claudeStats.estimatedCostUsd + openCodeData.estimatedCostUsd).toFixed(2));

  // Merge historical dates
  const combinedHistory = new Map<string, { tokens: number; cost: number }>();
  for (const [date, val] of claudeStats.historyMap.entries()) {
    combinedHistory.set(date, { ...val });
  }
  for (const [date, val] of openCodeData.historyMap.entries()) {
    const existing = combinedHistory.get(date);
    if (existing) {
      existing.tokens += val.tokens;
      existing.cost += val.cost;
    } else {
      combinedHistory.set(date, { ...val });
    }
  }

  // Build Trend & Activity Heatmap
  const trend7Days = buildTrend7Days(todayStr, combinedHistory, totalTokens, totalCost);
  const activityMap = buildActivityHeatmap(combinedHistory, todayStr, totalTokens);

  // Vorssaint Cache Efficiency & Savings
  const totalCachedTokens = claudeStats.cacheTokens + openCodeData.cacheTokens;
  const totalPromptTokens = claudeStats.promptTokens + openCodeData.promptTokens;
  const hitRatePercent = totalPromptTokens > 0 ? Math.round((totalCachedTokens / totalPromptTokens) * 100) : 0;
  const savingsUsd = parseFloat(((totalCachedTokens / 1_000_000) * 2.7).toFixed(2));

  // Provider distribution
  const claudeTokens = claudeStats.todayTokens;
  const openCodeTokens = openCodeData.todayTokens;
  const otherTokens = 0;
  const sumTokens = totalTokens || 1;
  const providerBreakdown: ProviderBreakdown = {
    claudeTokens,
    openCodeTokens,
    otherTokens,
    claudePercent: Math.round((claudeTokens / sumTokens) * 100),
    openCodePercent: Math.round((openCodeTokens / sumTokens) * 100),
    otherPercent: Math.round((otherTokens / sumTokens) * 100),
  };

  return {
    totalRunningAgents: detectedAgents.length,
    agents: detectedAgents,
    activeTask,
    mcpBridges: Array.from(activeMcpBridges),
    cacheEfficiency: {
      hitRatePercent,
      savingsUsd,
      cachedTokens: totalCachedTokens,
      promptTokens: totalPromptTokens,
    },
    providerBreakdown,
    trend7Days,
    activityMap,
    claudeTokenStats: {
      todayTokens: totalTokens,
      todayMessages: totalMessages,
      todayToolCalls: totalToolCalls,
      activeSessionsCount: detectedAgents
        .filter((a) => a.category === 'claude' || a.category === 'antigravity' || a.category === 'opencode')
        .reduce((acc, item) => acc + item.processCount, 0),
      primaryModel,
      estimatedCostUsd: totalCost,
    },
  };
}
