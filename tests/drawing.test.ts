import { describe, expect, it } from 'vitest';
import { technicalDrawingSvg } from '../src/export/drawing';
import bank from '../src/templates/bank.json';
import { valid } from './helpers';

const info = { title: 'Optimized layout', subtitle: 'Bank branch', date: '2026-11-01' };

describe('technical drawing', () => {
  const svg = technicalDrawingSvg(valid(bank), info);

  it('labels every area with its real size', () => {
    expect(svg).toContain('>TELLERS<');
    expect(svg).toContain('>2.0 × 1.5 m · 3 staff<');
    expect(svg).toContain('>WAITING AREA<');
    expect(svg).toContain('>4.0 × 1.2 m<');
  });

  it('dimensions the room from the plan scale (1000 × 700 px at 0.02 m/px)', () => {
    expect(svg).toContain('>20.0 m<');
    expect(svg).toContain('>14.0 m<');
  });

  it('has a scale bar and a title block', () => {
    expect(svg).toContain('>5 m<');
    expect(svg).toContain('>Optimized layout<');
    expect(svg).toContain('Dimensions in meters · 2026-11-01');
  });

  it('measures the room from its walls when there are walls', () => {
    const walled = valid({ ...bank, walls: [[[50, 100], [950, 100], [950, 600], [50, 600], [50, 100]]] });
    const s = technicalDrawingSvg(walled, info);
    expect(s).toContain('>18.0 m<');
    expect(s).toContain('>10.0 m<');
  });

  it('escapes names, so a label cannot break the drawing', () => {
    const odd = valid({ ...bank, blocks: bank.blocks.map((b) => (b.id === 'tellers' ? { ...b, label: 'A&B <desk>' } : b)) });
    expect(technicalDrawingSvg(odd, info)).toContain('>A&amp;B &lt;DESK&gt;<');
  });
});
