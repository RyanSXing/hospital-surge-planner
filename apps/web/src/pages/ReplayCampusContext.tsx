/** Original vector geography based on Vanderbilt's official visitor parking map.
 * Building silhouettes are simplified, not floor plans. Coordinates are the
 * official location record's location_lat_lon/GeoCoordinates, read 2026-10-17.
 */
export const VANDERBILT_CAMPUS = {
  latitude: 36.14229,
  longitude: -86.801627,
  location:
    "https://www.vanderbilthealth.com/locations/vanderbilt-university-medical-center",
  map: "https://www.vumc.org/med-center-parking/sites/default/files/public_files/VUMC%20Parking%20Map%20%28Visitor%29.pdf",
  emergency:
    "https://www.vanderbilthealth.com/locations/vanderbilt-emergency-department",
} as const;

export default function ReplayCampusContext() {
  return (
    <div className="replay-campus-context">
      <svg
        viewBox="0 0 620 380"
        role="img"
        aria-labelledby="replay-campus-title replay-campus-description"
      >
        <title id="replay-campus-title">
          Vanderbilt hospital campus in Nashville
        </title>
        <desc id="replay-campus-description">
          North-up local reference. Vanderbilt University Hospital lies west of
          Medical Center Drive, with the adult emergency entrance on that side
          and East Garage across the drive. Garland Avenue is north, Pierce
          Avenue south, and 21st Avenue South east. Simplified geometry, not to
          scale.
        </desc>
        <rect width="620" height="380" rx="14" fill="#f4f8fa" />
        <path d="M20 30H170V225H20Z M470 15H600V330H470Z" fill="#e8f1e9" />
        <g stroke="#d3dfe6" strokeWidth="26" fill="none" strokeLinejoin="round">
          <path d="M20 68H320Q350 68 350 40V18" />
          <path d="M350 40V344" />
          <path d="M500 10L475 365" />
          <path d="M20 278H490" />
          <path d="M150 20V360" />
          <path d="M20 348H600" />
        </g>
        <g stroke="#fff" strokeWidth="19" fill="none" strokeLinejoin="round">
          <path d="M20 68H320Q350 68 350 40V18" />
          <path d="M350 40V344" />
          <path d="M500 10L475 365" />
          <path d="M20 278H490" />
          <path d="M150 20V360" />
          <path d="M20 348H600" />
        </g>
        <g fill="#e6edf2" stroke="#cad9e3">
          <rect x="195" y="8" width="120" height="37" rx="5" />
          <rect x="375" y="90" width="82" height="52" rx="6" />
          <rect x="375" y="159" width="82" height="82" rx="6" />
          <rect x="190" y="229" width="122" height="30" rx="5" />
          <rect x="190" y="300" width="122" height="30" rx="5" />
        </g>
        <rect
          x="190"
          y="95"
          width="127"
          height="120"
          rx="12"
          fill="#e4f2fa"
          stroke="#1476bb"
          strokeWidth="2"
        />
        <circle cx="253" cy="126" r="12" fill="#1476bb" />
        <path d="M253 119V133M246 126H260" stroke="white" strokeWidth="3" />
        <circle cx="327" cy="190" r="7" fill="#d45d63" />
        <g
          fill="#304e62"
          fontFamily="var(--font-ui)"
          fontSize="11"
          textAnchor="middle"
        >
          <text x="253" y="157" fontWeight="650">
            Vanderbilt
          </text>
          <text x="253" y="173" fontWeight="650">
            University Hospital
          </text>
          <text x="253" y="191" fontSize="10">
            1211 Medical Center Dr
          </text>
          <text x="416" y="112">
            East Garage
          </text>
          <text x="416" y="128" fontSize="10">
            Across the drive
          </text>
          <text x="416" y="193">
            Medical Center
          </text>
          <text x="416" y="209">
            East
          </text>
          <text x="252" y="249" fontSize="10">
            The Vanderbilt Clinic
          </text>
          <text x="252" y="320" fontSize="10">
            Children's Hospital
          </text>
          <text x="252" y="31" fontSize="10">
            Medical Center North
          </text>
          <text x="83" y="72" fontSize="10">
            Garland Avenue
          </text>
          <text x="83" y="282" fontSize="10">
            Pierce Avenue
          </text>
          <text x="390" y="352" fontSize="10">
            Children's Way
          </text>
          <text transform="translate(354 156) rotate(-90)" fontSize="10">
            Medical Center Drive
          </text>
          <text transform="translate(491 205) rotate(-86)" fontSize="10">
            21st Avenue South
          </text>
          <text transform="translate(154 184) rotate(-90)" fontSize="10">
            23rd Avenue South
          </text>
        </g>
        <path d="M327 190L334 227H360" fill="none" stroke="#d45d63" />
        <text
          x="359"
          y="254"
          fill="#a8464b"
          fontFamily="var(--font-ui)"
          fontSize="10"
        >
          Adult ED entrance
        </text>
        <path
          d="M565 91V47M557 57L565 47L573 57"
          fill="none"
          stroke="#577285"
          strokeWidth="2"
        />
        <text
          x="565"
          y="35"
          fill="#577285"
          fontFamily="var(--font-ui)"
          fontSize="12"
          textAnchor="middle"
        >
          N
        </text>
        <text
          x="20"
          y="373"
          fill="#536b7d"
          fontFamily="var(--font-ui)"
          fontSize="10"
        >
          LOCAL REFERENCE · SIMPLIFIED GEOMETRY · NOT TO SCALE
        </text>
      </svg>
      <div className="replay-campus-caption">
        <strong>Centered on Vanderbilt, Nashville</strong>
        <p>
          Official location pin: {VANDERBILT_CAMPUS.latitude.toFixed(5)}° N,{" "}
          {Math.abs(VANDERBILT_CAMPUS.longitude).toFixed(6)}° W.
        </p>
        <p>
          This reference locates the hospital and surrounding streets. The
          replay below uses separate synthetic care zones; dots are not real
          geographic patient positions.
        </p>
        <a href={VANDERBILT_CAMPUS.map} target="_blank" rel="noreferrer">
          Official campus map ↗
        </a>
        <a href={VANDERBILT_CAMPUS.emergency} target="_blank" rel="noreferrer">
          Adult emergency entrance reference ↗
        </a>
      </div>
    </div>
  );
}
