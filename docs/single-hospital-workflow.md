# Single-hospital planning workflow

The workspace now focuses on one hospital. **Overview** shows the starting census and the simulation setup. **Analysis** contains Summary, Replay, Analytics and Comparison. Analytics has Outcomes and Patients & units. The separate Resources workspace and alternate-site/transfer planning controls have been removed from the current workflow.

1. Open **demo** on Overview. Choose a duration, adjust emergency arrivals, and choose whether the increase is steady, builds up, or rises and falls. The central arrivals chart updates immediately and compares the planned arrivals with usual demand. It is a demand preview; computed occupancy and queues appear after a simulation.
2. Open **More parameters** only when needed. Exact timing, care needs, additional patient groups, staffing, bed readiness, equipment, run counts and validation remain editable. These changes are saved in canonical scenario revisions. Empty assumption tracks and raw JSON editing are no longer part of setup.
3. Select **Run simulation**, then review Summary. Its four outcome cards match Analytics: new arrivals, completed discharges, placement waiting and ward utilization. The forecast timeline is visible beside the waiting chart; choose a metric, day or exact time directly from it.
4. Open Replay to follow patients through their recorded care stages. Playback buffers upcoming states and transition events, including short visits between snapshots. Discharged patients move to the discharge bay before their markers leave. Pause and seek reconstruct the exact displayed time. Patient and event details are optional.
5. Use Comparison to evaluate reserve staffing, opening hospital beds, or opening and staffing beds. New space is inside Ward C, and opening space does not manufacture staff or equipment. Save a selected response as a new scenario when useful.

Staff, equipment and beds can be inspected through focused search dialogs or unit details. Recording a change still creates a new forecast branch and preserves completed inputs. Data & setup and exports remain secondary tools. Legacy Resources links resolve to Patients & units; existing records and model artifacts remain readable.

The new immutable `hospital_baseline` fixture contains one hospital, five units, 84 starting patients, 100 installed ward beds (80 supported by staff), 12 ICU beds, and 30 emergency places (24 supported by staff). Ward C has 12 additional planned bed spaces. Reserve staff and equipment retain real allocation limits. The starter **demo** uses seven days, ten runs, and normal arrivals.

The geographic backdrop is centered at Vanderbilt University Hospital. Patient, staffing, demand and internal unit data are generated planning inputs, not Vanderbilt operational records. Provenance is available in model details and source metadata rather than persistent page badges.

The requested workspace reset archives prior scenarios recoverably. It does not delete their inputs, completed runs or stored artifacts. See the release's workspace-curation evidence for the exact archived IDs and backup checksum.
