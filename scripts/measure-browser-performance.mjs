/** Read-only hosted UI measurements. Requires an existing completed benchmark and private auth env. */
import { chromium } from '../apps/web/node_modules/playwright/index.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const benchmarkPath = process.env.BROWSER_BENCHMARK_FILE || 'evidence/cloud-benchmark-30d-100r.json';
const benchmark = JSON.parse(readFileSync(resolve(root, benchmarkPath), 'utf8'));
const baseURL = process.env.E2E_BASE_URL || benchmark.base_url;
const local = ['localhost', '127.0.0.1'].includes(new URL(baseURL).hostname);
const outputPrefix = process.env.BROWSER_OUTPUT_PREFIX || resolve(root, 'evidence/browser-hosted-performance');
const env = readFileSync(process.env.E2E_AUTH_ENV_FILE || resolve(root, 'data/deployment/production.env'), 'utf8');
const password = env.match(/^ADMIN_PASSWORD=(.*)$/m)?.[1]?.trim().replace(/^(["'])(.*)\1$/, '$2');
if (!baseURL || !password) throw Error('Hosted URL and private admin credential are required');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ baseURL, viewport: { width: 1600, height: 1000 }, reducedMotion: 'no-preference' });
const page = await context.newPage();
const pageErrors = [], mutations = [];
page.on('pageerror', error => pageErrors.push(error.message));
page.on('request', request => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method()) && !request.url().includes('/auth/')) mutations.push(new URL(request.url()).pathname);
});
const evidence = {
  recorded_at: new Date().toISOString(), base_url: baseURL,
  scope: `Read-only desktop Chrome measurements over ${local ? 'local HTTP (harness check)' : 'actual public HTTPS'}; existing completed run; first asset download and login excluded`,
  benchmark_evidence: benchmarkPath, run_group_id: benchmark.run_group_id,
  run_code_commit: benchmark.manifest?.code_commit,
  deployed_code_commit: JSON.parse(readFileSync(resolve(root, 'evidence/deployment.json'), 'utf8')).code_commit,
  deployment_identity_source: 'evidence/deployment.json (authenticated deployment record)',
  viewport: { width: 1600, height: 1000 },
};
const summary = values => {
  const sorted = [...values].sort((a,b) => a-b);
  return { samples: values, median_ms: sorted[Math.floor(sorted.length/2)], p95_ms: sorted[Math.ceil(sorted.length*0.95)-1], max_ms: sorted.at(-1) };
};
try {
  const login = await context.request.post('/api/auth/login', { data: local ? { demo_role: 'admin' } : { username: 'admin', password } });
  if (!login.ok()) throw Error('Hosted login failed');
  const get = async path => {
    const response = await context.request.get('/api' + path);
    if (!response.ok()) throw Error(`${path}: HTTP ${response.status()}`);
    return response.json();
  };
  const run = await get('/run-groups/' + benchmark.run_group_id);
  const rep = run.selected_replication_id;
  const metrics = await get('/run-groups/' + run.id + '/metrics');
  const start = run.start_at || metrics.start_at || benchmark.manifest.start_at;
  const end = run.end_at || metrics.end_at || benchmark.manifest.end_at;
  const scenario = benchmark.scenario_id || run.scenario_id;
  const url = view => `/?scenario=${scenario}&run=${run.id}&replication=${rep}&view=${view}`;
  await page.addInitScript(() => {
    window.__canvasDraws = [];
    const originalFill = CanvasRenderingContext2D.prototype.fillRect;
    const originalText = CanvasRenderingContext2D.prototype.fillText;
    const originalArc = CanvasRenderingContext2D.prototype.arc;
    CanvasRenderingContext2D.prototype.fillRect = function (...args) {
      if (this.canvas.classList.contains('replay-canvas') && args[0] === 0 && args[1] === 0 && args[2] === 1000 && args[3] === 620) this.__draw = { start: performance.now(), patient_arcs: 0 };
      return originalFill.apply(this, args);
    };
    CanvasRenderingContext2D.prototype.arc = function (...args) {
      // Patient dots have radius 3.6 or 6; the selected-patient ring is 10.
      if (this.__draw && args[2] <= 6) this.__draw.patient_arcs++;
      return originalArc.apply(this, args);
    };
    CanvasRenderingContext2D.prototype.fillText = function (...args) {
      const result = originalText.apply(this, args);
      if (this.__draw && String(args[0]).startsWith('STATE SCHEMATIC')) {
        window.__canvasDraws.push({ ...this.__draw, end: performance.now(), duration_ms: performance.now()-this.__draw.start });
        this.__draw = null;
      }
      return result;
    };
  });
  const useful = async () => {
    await page.locator('.overview-page').waitFor();
    await page.waitForFunction(() => document.querySelector('.map-caption')?.textContent.includes('selected simulation run') && [...document.querySelectorAll('.kpi-strip .stat-value')].length === 4 && [...document.querySelectorAll('.kpi-strip .stat-value')].every(e => !e.textContent.includes('—')));
    await page.evaluate(() => document.fonts.ready);
  };
  await page.goto(url('overview'));
  await useful();
  const navigation = [];
  for (let i=0; i<5; i++) {
    await page.reload(); await useful();
    navigation.push(await page.evaluate(() => performance.now()));
  }
  evidence.warm_authenticated_navigation = { ...summary(navigation), target_ms: 3000, all_within_target: navigation.every(x=>x<3000), endpoint: 'Useful selected-run Overview with populated metrics and exact state' };
  const panels = [];
  for (let i=0; i<12; i++) {
    panels.push(await page.evaluate(() => new Promise(resolve => {
      const button = document.querySelector('[aria-controls="overview-facility-inspector"]');
      const prior = button.getAttribute('aria-expanded');
      const start = performance.now();
      const observer = new MutationObserver(() => {
        if (button.getAttribute('aria-expanded') !== prior) {
          observer.disconnect(); resolve(performance.now()-start);
        }
      });
      observer.observe(button, { attributes: true, attributeFilter: ['aria-expanded'] });
      button.click();
    })));
  }
  evidence.local_panel_update = { ...summary(panels), target_ms: 100, all_within_target: panels.every(x=>x<100), endpoint: 'Browser click dispatch to committed aria-expanded mutation; excludes Playwright driver latency' };
  await page.goto(url('replay'));
  await page.locator('.replay-canvas').waitFor();
  await page.getByText('Loading the exact state at this timestamp…', { exact: true }).waitFor({ state: 'hidden' });
  const stateStart = await get(`/runs/${rep}/state?at=${encodeURIComponent(start)}`);
  const stateEnd = await get(`/runs/${rep}/state?at=${encodeURIComponent(end)}`);
  async function seek(label, total) {
    return page.evaluate(({label,total}) => new Promise((resolve,reject) => {
      const button = document.querySelector(`[aria-label="${label}"]`);
      const begin = performance.now();
      const previousDraws = window.__canvasDraws.length;
      const check = () => {
        const canvas = document.querySelector('.replay-canvas');
        const loading = [...document.querySelectorAll('[role="status"]')].some(e => e.textContent.includes('Loading the exact state'));
        if (window.__canvasDraws.length > previousDraws && canvas?.getAttribute('aria-label').includes(`${total} active patients;`) && !loading) return resolve(performance.now()-begin);
        if (performance.now()-begin > 15000) return reject(Error('Seek state did not render'));
        requestAnimationFrame(check);
      };
      button.click(); requestAnimationFrame(check);
    }),{label,total});
  }
  // Warm both selected timestamps and their exact state/query caches before recording.
  await seek('Go to run horizon', stateEnd.patient_total);
  await seek('Return to run start', stateStart.patient_total);
  const seeks = [];
  for(let i=0;i<6;i++) seeks.push(await seek(i%2 ? 'Return to run start' : 'Go to run horizon', i%2 ? stateStart.patient_total : stateEnd.patient_total));
  evidence.cached_timeline_seek = { ...summary(seeks), target_ms: 500, all_within_target: seeks.every(x=>x<500), endpoint: 'Browser click to exact timestamp canvas redraw, expected full patient count, and cleared loading indicator' };
  // Measure a late state, where a sustained surge can exercise the full token
  // budget. Keep 24 simulated hours available for the eight-second playback.
  const lateAt = new Date(Math.max(Date.parse(start), Date.parse(end)-24*60*60*1000)).toISOString();
  const lateState = await get(`/runs/${rep}/state?at=${encodeURIComponent(lateAt)}`);
  await page.goto(url('replay') + '&at=' + encodeURIComponent(lateAt));
  await page.locator('.replay-canvas').waitFor();
  await page.waitForFunction(total => window.__canvasDraws.length > 0 && document.querySelector('.replay-canvas')?.getAttribute('aria-label').includes(`${total} active patients;`) && ![...document.querySelectorAll('[role="status"]')].some(e => e.textContent.includes('Loading the exact state')), lateState.patient_total);
  await page.getByRole('button', { name: '1×', exact: true }).click();
  const replayStart = await page.evaluate(() => ({label:document.querySelector('.replay-canvas').getAttribute('aria-label')}));
  const cadence = await page.evaluate(() => new Promise(resolve => {
    window.__canvasDraws=[];
    const stamps=[], begin=performance.now();
    document.querySelector('[aria-label="Play replay"]').click();
    const frame=now=>{
      stamps.push(now);
      if(now-begin<8000) requestAnimationFrame(frame);
      else resolve({elapsed_ms:now-begin, intervals:stamps.slice(1).map((x,i)=>x-stamps[i]), frames:stamps.length-1, draws:window.__canvasDraws.filter(x=>x.start>=begin&&x.end<=now)});
    };
    requestAnimationFrame(frame);
  }));
  await page.getByRole('button',{name:'Pause replay',exact:true}).click();
  const replayEnd = await page.evaluate(() => ({draws:window.__canvasDraws,label:document.querySelector('.replay-canvas').getAttribute('aria-label'),selected_time:document.querySelector('.replay-time strong').textContent}));
  evidence.interactive_replay = {
    observed_seconds: cadence.elapsed_ms/1000,
    raf_frames_per_second: cadence.frames/(cadence.elapsed_ms/1000),
    raf_interval: summary(cadence.intervals),
    canvas_redraws_per_second: cadence.draws.length/(cadence.elapsed_ms/1000),
    canvas_redraw_count: cadence.draws.length,
    canvas_redraws: cadence.draws,
    requested_late_timestamp: lateAt,
    initial_full_patient_total: lateState.patient_total,
    initial_bounded_state_patients: lateState.patients.length,
    max_visible_patient_arcs: Math.max(0,...cadence.draws.map(x=>x.patient_arcs)),
    visible_patient_budget: 500,
    reached_visible_patient_budget: cadence.draws.some(x=>x.patient_arcs>=500),
    start_state: replayStart.label, end_state: replayEnd.label, selected_time:replayEnd.selected_time,
    interpretation: 'rAF cadence measures browser responsiveness, not canvas rendering FPS. Canvas redraws are counted separately from actual renderer calls and may occur only with state changes; this result does not establish 30 FPS patient motion. Replay advances one simulated hour per real second and pauses advancement while remote state loads. Patient dots exclude the selection ring; the achieved count is measured, not assumed to be 500.'
  };
  await page.screenshot({path:outputPrefix + '.png',fullPage:true});
  evidence.page_errors=pageErrors; evidence.model_mutations=mutations;
  evidence.browser_version=browser.version();
} finally {
  await browser.close();
  writeFileSync(outputPrefix + '.json',JSON.stringify(evidence,null,2)+'\n');
}
console.log(JSON.stringify({navigation:evidence.warm_authenticated_navigation,panel:evidence.local_panel_update,seek:evidence.cached_timeline_seek,raf_fps:evidence.interactive_replay?.raf_frames_per_second,page_errors:pageErrors,model_mutations:mutations}));
