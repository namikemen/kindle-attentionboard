import assert from 'assert';
import { getNowPlaying } from '../src/collectors/musicCollector';
import { getAgentTelemetry } from '../src/collectors/agentCollector';
import { getSchedule } from '../src/collectors/tasksCollector';
import { getSystemHealth } from '../src/collectors/systemCollector';
import { getAppleDevicesBattery } from '../src/collectors/appleBatteryCollector';
import { getWeatherData } from '../src/collectors/weatherCollector';
import { getSubscriptionQuota } from '../src/collectors/subscriptionCollector';
import { gatherDashboardData, renderDashboardHtml } from '../src/render/templateRenderer';

async function runTests() {
  console.log('--- Starting Kindle AttentionBoard Test Suite ---');

  // 1. Music Collector
  console.log('Testing: musicCollector...');
  const music = await getNowPlaying();
  assert.ok(typeof music.title === 'string', 'music.title should be a string');
  assert.ok(typeof music.artist === 'string', 'music.artist should be a string');
  assert.ok(typeof music.isPlaying === 'boolean', 'music.isPlaying should be a boolean');
  console.log(`✓ Music collector passed (hasMedia: ${music.hasMedia}, source: "${music.source}", title: "${music.title}")`);

  // 2. Agent Collector
  console.log('Testing: agentCollector...');
  const agents = await getAgentTelemetry();
  assert.ok(typeof agents.totalRunningAgents === 'number', 'totalRunningAgents should be a number');
  assert.ok(Array.isArray(agents.agents), 'agents.agents should be an array');
  assert.ok(typeof agents.claudeTokenStats.todayTokens === 'number', 'todayTokens should be a number');
  console.log(`✓ Agent collector passed (detected ${agents.totalRunningAgents} agents: ${agents.agents.map((a) => a.name).join(', ')})`);

  // 3. Tasks & Calendar Collector
  console.log('Testing: tasksCollector...');
  const schedule = await getSchedule();
  assert.ok(Array.isArray(schedule.todayTasks), 'schedule.todayTasks should be an array');
  assert.ok(Array.isArray(schedule.weekTasks), 'schedule.weekTasks should be an array');
  assert.ok(Array.isArray(schedule.todayEvents), 'schedule.todayEvents should be an array');
  assert.ok(Array.isArray(schedule.weekEvents), 'schedule.weekEvents should be an array');
  console.log(`✓ Tasks collector passed (${schedule.todayEvents.length} today events, ${schedule.weekEvents.length} week events, ${schedule.todayTasks.length} today tasks, ${schedule.weekTasks.length} week tasks)`);

  // 4. System Health Collector
  console.log('Testing: systemCollector...');
  const sys = await getSystemHealth();
  assert.ok(sys.cpuUsagePercent >= 0 && sys.cpuUsagePercent <= 100, 'cpuUsagePercent should be between 0 and 100');
  assert.ok(sys.gpu.usagePercent >= 0 && sys.gpu.usagePercent <= 100, 'gpu.usagePercent should be between 0 and 100');
  assert.ok(sys.memory.totalGb > 0, 'memory.totalGb should be > 0');
  assert.ok(sys.disk.totalGb > 0, 'disk.totalGb should be > 0');
  assert.ok(Array.isArray(sys.topCpuApps), 'topCpuApps should be an array');
  assert.ok(Array.isArray(sys.topMemApps), 'topMemApps should be an array');
  console.log(`✓ System health passed (CPU: ${sys.cpuUsagePercent}%, GPU: ${sys.gpu.usagePercent}%, RAM: ${sys.memory.usedPercent}%, Top CPU: ${sys.topCpuApps.map(a => `${a.name} ${a.cpuPercent}%`).slice(0, 3).join(', ') || 'none'}, Top RAM: ${sys.topMemApps.map(a => `${a.name} ${a.memoryMb}MB`).slice(0, 3).join(', ') || 'none'})`);

  // 5. Apple Battery Collector
  console.log('Testing: appleBatteryCollector...');
  const devices = await getAppleDevicesBattery();
  assert.ok(Array.isArray(devices), 'devices should be an array');
  assert.ok(devices.length > 0, 'should detect at least host macbook battery');
  console.log(`✓ Apple battery passed (${devices.length} devices detected: ${devices.map((d) => `${d.name} (${d.statusText})`).join(', ')})`);

  // 6. Weather Collector
  console.log('Testing: weatherCollector...');
  const weather = await getWeatherData();
  assert.ok(typeof weather.temperature === 'number', 'weather.temperature should be a number');
  assert.ok(typeof weather.condition === 'string', 'weather.condition should be a string');
  console.log(`✓ Weather collector passed (${weather.temperature}°C, ${weather.condition} in ${weather.city})`);

  // 7. Subscription Quota Collector (Google AI Pro / Antigravity)
  console.log('Testing: subscriptionCollector...');
  const quota = await getSubscriptionQuota();
  assert.ok(typeof quota.available === 'boolean', 'quota.available should be a boolean');
  assert.ok(Array.isArray(quota.providers), 'quota.providers should be an array');
  for (const p of quota.providers) {
    assert.ok(Array.isArray(p.windows), `provider "${p.name}" windows should be an array`);
  }
  console.log(`✓ Subscription quota passed (available: ${quota.available}, providers: ${quota.providers.length}${quota.error ? `, error: ${quota.error}` : ''})`);

  // 8. Template Renderer (All 3 Tabs)
  console.log('Testing: templateRenderer (Tabs 1, 2, 3)...');
  const data = await gatherDashboardData();
  for (const tabId of [1, 2, 3] as const) {
    const html = renderDashboardHtml(data, false, tabId);
    assert.ok(html.includes(`Tab ${tabId}/3`), `HTML for tab ${tabId} should show Tab ${tabId}/3`);
    assert.ok(html.includes(`class="tab-panel tab-panel-active" id="tab-panel-${tabId}"`), `Tab panel ${tabId} should be active`);
    assert.ok(!html.includes('{{'), `All template tokens should be replaced in tab ${tabId}`);
  }
  console.log('✓ Template renderer passed for all 3 tabs');

  console.log('--- ALL TESTS PASSED SUCCESSFULLY! ---');
  process.exit(0);
}

runTests().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
