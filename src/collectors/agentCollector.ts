import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { calculateTokenCost } from '../logic/costEstimator';

const execAsync = promisify(exec);

export interface DetectedAgent {
  name: string;
  category: 'antigravity' | 'claude' | 'copilot' | 'codex' | 'zed' | 'cursor' | 'mcp' | 'other';
  pid: number;
  cpuPercent: number;
  memoryMb: number;
  processCount: number;
  detail: string;
  status: 'running' | 'busy' | 'idle';
  commandPreview: string;
}

export interface AgentTelemetry {
  totalRunningAgents: number;
  agents: DetectedAgent[];
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
    pattern: /chrome-devtools-mcp|apple-tools-mcp|mcp-remote|code-review-graph|biomolecular_structure_viewer_mcp/i,
    name: 'MCP Tool Servers',
    category: 'mcp',
    defaultDetail: 'Active Bridges',
  },
];

function getTodayString(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseClaudeStatsCache(): {
  todayTokens: number;
  todayMessages: number;
  todayToolCalls: number;
  primaryModel: string;
  estimatedCostUsd: number;
} {
  const defaultStats = {
    todayTokens: 0,
    todayMessages: 0,
    todayToolCalls: 0,
    primaryModel: 'claude-opus / sonnet',
    estimatedCostUsd: 0,
  };

  const cachePath = path.join(os.homedir(), '.claude/stats-cache.json');
  if (!fs.existsSync(cachePath)) {
    return defaultStats;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    const today = getTodayString();

    let todayTokens = 0;
    let todayMessages = 0;
    let todayToolCalls = 0;

    if (Array.isArray(raw.dailyActivity)) {
      const todayActivity = raw.dailyActivity.find((item: { date: string }) => item.date === today)
        || raw.dailyActivity[raw.dailyActivity.length - 1];
      if (todayActivity) {
        todayMessages = todayActivity.messageCount || 0;
        todayToolCalls = todayActivity.toolCallCount || 0;
      }
    }

    if (Array.isArray(raw.dailyModelTokens)) {
      const todayModelTokens = raw.dailyModelTokens.find((item: { date: string }) => item.date === today)
        || raw.dailyModelTokens[raw.dailyModelTokens.length - 1];
      if (todayModelTokens && typeof todayModelTokens === 'object') {
        for (const [key, val] of Object.entries(todayModelTokens)) {
          if (key !== 'date' && typeof val === 'number') {
            todayTokens += val;
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

    const costResult = calculateTokenCost({
      inputTokens: Math.round(todayTokens * 0.4),
      outputTokens: Math.round(todayTokens * 0.2),
      cacheReadTokens: Math.round(todayTokens * 0.4),
      cacheWriteTokens: 0,
      modelName: primaryModel,
    });

    return {
      todayTokens,
      todayMessages,
      todayToolCalls,
      primaryModel,
      estimatedCostUsd: costResult.estimatedCostUsd,
    };
  } catch {
    return defaultStats;
  }
}

export async function getAgentTelemetry(): Promise<AgentTelemetry> {
  const detectedAgents: DetectedAgent[] = [];

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

  // Sort agents: active/busy or primary coding agents first
  detectedAgents.sort((a, b) => {
    if (a.category === 'mcp' && b.category !== 'mcp') return 1;
    if (b.category === 'mcp' && a.category !== 'mcp') return -1;
    return b.cpuPercent - a.cpuPercent || b.memoryMb - a.memoryMb;
  });

  const claudeStats = parseClaudeStatsCache();
  const claudeCli = detectedAgents.find((a) => a.name === 'Claude Code CLI');
  if (claudeCli && claudeCli.detail && claudeCli.detail !== 'Agent Session') {
    claudeStats.primaryModel = claudeCli.detail;
  }

  return {
    totalRunningAgents: detectedAgents.length,
    agents: detectedAgents,
    claudeTokenStats: {
      ...claudeStats,
      activeSessionsCount: detectedAgents
        .filter((a) => a.category === 'claude' || a.category === 'antigravity')
        .reduce((acc, item) => acc + item.processCount, 0),
    },
  };
}
