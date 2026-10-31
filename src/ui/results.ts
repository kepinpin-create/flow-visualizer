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

  const skipped = r.theorySkipped.map((s) => `<p class="note">${esc(s)}</p>`).join('');
  const theory = (r.theory.length
    ? `<div class="table-wrap"><table>
        <thead><tr><th>Station</th><th>Staff (c)</th><th>Arrivals/h (λ)</th><th>Served/h per staff (μ)</th><th>Busy (ρ)</th>
          <th>Wait, simulated (Wq)</th><th>Wait, formula</th><th>Gap</th>
          <th>Line, simulated (Lq)</th><th>Line, formula</th><th>Gap</th><th></th></tr></thead>
        <tbody>${r.theory.map((t) => `
          <tr>
            <td>${esc(t.label || t.id)}</td><td>${t.c}</td>
            <td>${num(t.lambdaPerHour, 1)}</td><td>${num(t.muPerHour, 1)}</td><td>${num(t.rho, 3)}</td>
            <td>${est(t.wq.simulated, 3)}</td><td>${num(t.wq.analytical, 3)}</td><td>${num(t.wq.errorPct, 1)}%</td>
            <td>${est(t.lq.simulated, 3)}</td><td>${num(t.lq.analytical, 3)}</td><td>${num(t.lq.errorPct, 1)}%</td>
            <td>${theoryBadge[t.status]}</td>
          </tr>`).join('')}</tbody></table></div>
      ${r.theory.some((t) => t.status === 'withinCI')
        ? '<p class="note">"Within CI": the gap is 5% or more, but the formula\'s value lies inside the simulation\'s 95% range (confidence interval), so it is run-length noise. Raise hours or replications to tighten it.</p>'
        : ''}`
    : skipped
      ? ''
      : `<p class="note">No station fits the formula (M/M/c). It needs random arrivals (Poisson), random service times (exponential) and an unlimited first-come line, with nothing before it that breaks those.</p>`) + skipped;

  const little = r.little.map((l) => `
    <tr><td>${esc(l.scope)}</td><td>${num(l.L, 3)}</td><td>${num(l.lambdaW, 3)}</td>
      <td>${num(l.errorPct, 1)}%</td><td>${l.skipped ? '<span class="badge warn">Not steady</span>' : badge(l.pass)}</td></tr>`).join('');
  const littleNotes = r.little.filter((l) => l.skipped).map((l) => `<p class="note">${esc(l.skipped!)}</p>`).join('');

  const warnings = r.warnings.map((w) => `<div class="issue warning">${esc(w.message)}</div>`).join('');

  return `
    <h2>System</h2>
    <p class="note">Averages over ${r.replications} simulated days (replications); ± is the 95% range. Times in minutes.</p>
    <div class="kpis">
      ${kpi(`Served per hour (${esc(entity)}s)`, est(s.throughputPerHour, 1))}
      ${kpi('Time from arrival to leaving (W)', est(s.W))}
      ${kpi(`Inside at once (L, ${esc(entity)}s)`, est(s.L))}
      ${kpi('Left because the line was too long', est(s.balkRate, 1, 100) + '%')}
      ${kpi('Walk per ' + esc(entity) + ' (m)', est(s.travelMeanM, 1))}
    </div>

    ${warnings ? `<h2>Warnings</h2>${warnings}` : ''}

    <h2>Stations</h2>
    <div class="table-wrap"><table>
      <thead><tr><th>Station</th><th>Staff (c)</th><th>Busy (ρ)</th><th>Average wait (Wq)</th><th>9 in 10 wait less than (p90)</th>
        <th>Average line (Lq)</th><th>Longest line</th><th>Arrivals/h (λ)</th></tr></thead>
      <tbody>${stationRows}</tbody>
    </table></div>

    <h2>Check against queuing theory (Erlang-C)</h2>
    <p class="note">Where the textbook formula applies, the simulation should land close to it.</p>
    ${theory}

    <h2>Consistency check (Little's Law, L = λW)</h2>
    <p class="note">People present on average should equal arrivals per minute × minutes each one stays.</p>
    <div class="table-wrap"><table>
      <thead><tr><th>Where</th><th>People present (L)</th><th>Arrivals × time (λW)</th><th>Gap</th><th></th></tr></thead>
      <tbody>${little}</tbody>
    </table></div>${littleNotes}`;
}
