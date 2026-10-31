import type { NodeClass } from "../snapshot";

/**
 * Chart marks. Each class has its own silhouette, drawn after the conventions
 * of nautical charts, so status reads without colour: a surveyed position, a
 * lozenge buoy, a triangulation point and an obstruction ringed by a danger
 * line. Colour only repeats what the shape already says.
 */

export function ClassMark({ cls, size = 20 }: { cls: NodeClass; size?: number }) {
  return (
    <svg
      className="glyph"
      data-cls={cls}
      width={size}
      height={size}
      viewBox="0 0 20 20"
      aria-hidden="true"
      focusable="false"
    >
      <rect className="glyph__ground" x="1" y="1" width="18" height="18" rx="9" />
      {cls === "fresh" && (
        <>
          <circle cx="10" cy="10" r="5.4" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <circle cx="10" cy="10" r="1.5" fill="currentColor" />
        </>
      )}
      {cls === "queue" && (
        <path
          d="M10 2.8 17.2 10 10 17.2 2.8 10Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="miter"
        />
      )}
      {cls === "review" && (
        <>
          <path
            d="M10 2.6 17.6 16H2.4Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="miter"
          />
          <circle cx="10" cy="11.6" r="1.7" fill="currentColor" />
        </>
      )}
      {cls === "alert" && (
        <>
          <circle
            cx="10"
            cy="10"
            r="8.6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeDasharray="0.1 3.27"
            strokeLinecap="round"
          />
          <path
            d="M10 4.2v11.6M4.2 10h11.6"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="butt"
          />
        </>
      )}
    </svg>
  );
}

/** A feathered current arrow: change is arriving from upstream. */
export function UpstreamMark({ size = 14 }: { size?: number }) {
  return (
    <svg className="glyph glyph--upstream" width={size} height={size} viewBox="0 0 14 14" aria-hidden="true">
      <path
        d="M1 7h11M8.4 3.6 12 7l-3.6 3.4M1 4.4 3 7 1 9.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  );
}

/** Anchorage: this node was settled by reading the code. */
export function AnchorMark({ size = 14 }: { size?: number }) {
  return (
    <svg className="glyph glyph--anchor" width={size} height={size} viewBox="0 0 14 14" aria-hidden="true">
      <circle cx="7" cy="2.6" r="1.4" fill="none" stroke="currentColor" strokeWidth="1.1" />
      <path
        d="M7 4v8.4M4.4 6h5.2M1.8 8.2c.5 2.6 2.6 4.2 5.2 4.2s4.7-1.6 5.2-4.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.1"
      />
    </svg>
  );
}

/** The word mark's device: a keel line under a surveyed position. */
export function KeelMark() {
  return (
    <svg className="keel" width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
      <circle cx="11" cy="9" r="6.4" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="11" cy="9" r="1.7" fill="currentColor" />
      <path d="M1 18.6h20M11 15.4v6" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

export function WakeSample() {
  return (
    <svg className="glyph" width="30" height="12" viewBox="0 0 30 12" aria-hidden="true">
      <path className="sample-wake-band" d="M1 6h28" />
      <path className="sample-wake-line" d="M1 6h28" />
    </svg>
  );
}

export function FogSample() {
  return (
    <svg className="glyph" width="22" height="12" viewBox="0 0 22 12" aria-hidden="true">
      <rect width="22" height="12" fill="url(#mk-stipple-small)" />
    </svg>
  );
}

/** Pattern definitions shared by legends and the chart. */
export function SharedDefs() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
      <defs>
        <pattern id="mk-stipple-small" width="4" height="4" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="0.6" className="stipple-dot" />
          <circle cx="3" cy="3" r="0.6" className="stipple-dot" />
        </pattern>
      </defs>
    </svg>
  );
}
