import type { ExperimentResult } from '../engine/experiment';
import type { Estimate } from '../engine/stats';

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const num = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '∞');
const est = (e: Estimate, d = 2, scale = 1) =>
  `${num(e.mean * scale, d)} <span class="ci">± ${num(e.half * scale, d)}</span>`;
const badge = (ok: boolean) => `<span class="badge ${ok ? 'ok' : 'bad'}">${ok ? 'Pass' : 'Fail'}</span>`;

const theoryBadge = {
  match: '<span class="badge ok">Under 5%</span>',
  withinCI: '<span class="badge warn">Within CI</span>',
  mismatch: '<span class="badge bad">Mismatch</span>',
};

/** FR-22–FR-26: the KPI dashboard, theory check, Little's Law and warnings. */
export function resultsHtml(r: ExperimentResult, entity: string): string {
  const s = r.system;
  const kpi = (label: string, value: string) =>
    `<div class="kpi"><div class="label">${label}</div><div class="value">${value}</div></div>`;

  const stationRows = r.stations.map((st) => `
    <tr>
      <td>${esc(st.label || st.id)} ${st.bottleneck ? '<span class="badge warn">Bottleneck</span>' : ''}</td>
      <td>${st.servers}</td>
      <td>${est(st.utilization, 1, 100)}%</td>
      <td>${est(st.wqMean)}</td>
      <td>${est(st.wqP90)}</td>
      <td>${est(st.lqMean)}</td>
      <td>${est(st.lqMax, 1)}</td>
      <td>${est(st.arrivalsPerHour, 1)}</td>
    </tr>`).join('');

  const theory = r.theory.length
    ? `<div class="table-wrap"><table>
        <thead><tr><th>Station</th><th>c</th><th>λ/h</th><th>μ/h</th><th>ρ</th>
          <th>Wq sim</th><th>Wq Erlang-C</th><th>Error</th>
          <th>Lq sim</th><th>Lq Erlang-C</th><th>Error</th><th></th></tr></thead>
        <tbody>${r.theory.map((t) => `
          <tr>
            <td>${esc(t.label || t.id)}</td><td>${t.c}</td>
            <td>${num(t.lambdaPerHour, 1)}</td><td>${num(t.muPerHour, 1)}</td><td>${num(t.rho, 3)}</td>
            <td>${est(t.wq.simulated, 3)}</td><td>${num(t.wq.analytical, 3)}</td><td>${num(t.wq.errorPct, 1)}%</td>
            <td>${est(t.lq.simulated, 3)}</td><td>${num(t.lq.analytical, 3)}</td><td>${num(t.lq.errorPct, 1)}%</td>
            <td>${theoryBadge[t.status]}</td>
          </tr>`).join('')}</tbody></table></div>
      ${r.theory.some((t) => t.status === 'withinCI')
        ? '<p class="note">"Within CI": the gap is 5% or more, but Erlang-C lies inside the 95% confidence interval, so it is run-length noise. Raise hours or replications to tighten it.</p>'
        : ''}`
    : `<p class="note">No station qualifies as M/M/c. A station needs Poisson arrivals, exponential service and an unlimited FIFO line, with nothing upstream that breaks those.</p>`;

  const little = r.little.map((l) => `
    <tr><td>${esc(l.scope)}</td><td>${num(l.L, 3)}</td><td>${num(l.lambdaW, 3)}</td>
      <td>${num(l.errorPct, 1)}%</td><td>${badge(l.pass)}</td></tr>`).join('');

  const warnings = r.warnings.map((w) => `<div class="issue warning">${esc(w.message)}</div>`).join('');

  return `
    <h2>System</h2>
    <p class="note">Means over ${r.replications} replications, ± 95% confidence half-width. Times in minutes.</p>
    <div class="kpis">
      ${kpi(`Throughput (${esc(entity)}s/h)`, est(s.throughputPerHour, 1))}
      ${kpi('Time in system W', est(s.W))}
      ${kpi('Work in system L', est(s.L))}
      ${kpi('Balk rate', est(s.balkRate, 1, 100) + '%')}
      ${kpi('Travel per ' + esc(entity) + ' (m)', est(s.travelMeanM, 1))}
    </div>

    ${warnings ? `<h2>Warnings</h2>${warnings}` : ''}

    <h2>Stations</h2>
    <div class="table-wrap"><table>
      <thead><tr><th>Station</th><th>c</th><th>Utilization ρ</th><th>Wq mean</th><th>Wq p90</th>
        <th>Lq mean</th><th>Lq max</th><th>Arrivals/h</th></tr></thead>
      <tbody>${stationRows}</tbody>
    </table></div>

    <h2>Theory check (Erlang-C)</h2>
    ${theory}

    <h2>Little's Law (L = λW)</h2>
    <div class="table-wrap"><table>
      <thead><tr><th>Scope</th><th>L</th><th>λW</th><th>Gap</th><th></th></tr></thead>
      <tbody>${little}</tbody>
    </table></div>`;
}
