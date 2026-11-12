import { memo } from 'react';

export type Series = { id: string; points: Array<[number, number | null]>; tone?: 'line' | 'ceiling' };

/**
 * A calm static SVG line chart. No animation: each new frame redraws the paths and the data is the motion.
 * Fixed x range (the whole run) so lines grow left to right instead of rescaling; y only grows.
 */
export const LineChart = memo(function LineChart({
  series,
  xMax,
  yMin = 0,
  yMax,
  bands = [],
  xTicks = [],
  label,
  height = 72,
}: {
  series: Series[];
  xMax: number;
  yMin?: number;
  yMax: number;
  bands?: Array<[number, number]>;
  xTicks?: number[];
  label: string;
  height?: number;
}) {
  const W = 300;
  const H = height;
  const pad = 2;
  const x = (v: number) => (Math.max(0, Math.min(xMax, v)) / Math.max(1, xMax)) * W;
  const y = (v: number) => H - pad - ((Math.max(yMin, v) - yMin) / Math.max(1, yMax - yMin)) * (H - pad * 2);
  const path = (pts: Series['points']) => {
    let d = '';
    let pen = false;
    for (const [px, py] of pts) {
      if (py === null) {
        pen = false;
        continue;
      }
      d += `${pen ? 'L' : 'M'}${x(px).toFixed(1)},${y(py).toFixed(1)}`;
      pen = true;
    }
    return d;
  };
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label}>
      {bands.map(([a, b], i) => (
        <rect key={i} className="chart-band" x={x(a)} y={0} width={Math.max(1, x(b) - x(a))} height={H} />
      ))}
      {xTicks.map((t) => (
        <line key={t} className="chart-tick" x1={x(t)} x2={x(t)} y1={0} y2={H} vectorEffect="non-scaling-stroke" />
      ))}
      {series.map((s) => (
        <path key={s.id} className="chart-line" data-tone={s.tone ?? 'line'} d={path(s.points)} vectorEffect="non-scaling-stroke" fill="none" />
      ))}
    </svg>
  );
});
