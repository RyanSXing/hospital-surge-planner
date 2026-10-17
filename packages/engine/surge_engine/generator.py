"""Deterministic, entirely synthetic canonical hospital inventory and history."""

from __future__ import annotations

from datetime import timedelta
from zoneinfo import ZoneInfo

from .common import *

HOURS = [0.02] * 6 + [0.04] * 6 + [0.06] * 6 + [0.28 / 6] * 6
WEEKDAYS = [1.05, 1.05, 1.02, 1.02, 1.08, 0.92, 0.86]
SITES = [
    ("MAIN", "Central Hospital", "hospital", 36.1447, -86.8026, "active", 0),
    ("EAST", "Partner East", "hospital", 36.1468, -86.7961, "active", 0),
    ("WEST", "Partner West", "hospital", 36.1438, -86.8116, "active", 0),
    ("CLINIC-NORTH", "Clinic North", "clinic", 36.1505, -86.8022, "candidate", 360),
    ("OVERFLOW-SOUTH", "Overflow South", "ward_overflow", 36.1378, -86.8039, "candidate", 720),
    ("SHELTER-WEST", "Shelter West", "shelter", 36.1452, -86.8144, "active", 0),
]
UNITS = [
    ("WARD-A", "MAIN", "ward", 40, 32, 0, 8, 1, 4),
    ("WARD-B", "MAIN", "ward", 40, 32, 0, 8, 1, 4),
    ("WARD-C", "MAIN", "ward", 20, 16, 0, 4, 1, 2),
    ("ICU", "MAIN", "icu", 12, 12, 0, 6, 1, 2),
    ("ED", "MAIN", "ed", 30, 24, 0, 6, 2, 2),
    ("EAST-WARD", "EAST", "ward", 32, 24, 20, 0, 0, 0),
    ("EAST-ICU", "EAST", "icu", 4, 4, 3, 0, 0, 0),
    ("WEST-WARD", "WEST", "ward", 36, 28, 24, 0, 0, 0),
    ("WEST-ICU", "WEST", "icu", 4, 4, 4, 0, 0, 0),
    ("CLINIC-NORTH", "CLINIC-NORTH", "clinic", 12, 0, 0, 0, 0, 0),
    ("OVERFLOW-SOUTH", "OVERFLOW-SOUTH", "ward", 0, 0, 0, 0, 0, 0),
    ("SHELTER-WEST", "SHELTER-WEST", "shelter", 24, 24, 0, 0, 0, 0),
]
TEMPLATES = [
    ("RES-WARD-SHORT", "remaining_los", 2, 12),
    ("RES-WARD-STANDARD", "remaining_los", 4, 24),
    ("RES-WARD-EXTENDED", "remaining_los", 4, 60),
    ("RES-ICU-STANDARD", "remaining_los", 3, 24),
    ("RES-ICU-EXTENDED", "remaining_los", 4, 48),
    ("LOS-WARD-SHORT", "total_los", 3, 12),
    ("LOS-WARD-STANDARD", "total_los", 4, 24),
    ("LOS-WARD-EXTENDED", "total_los", 5, 48),
    ("LOS-ICU-STANDARD", "total_los", 5, 12),
    ("LOS-ICU-EXTENDED", "total_los", 6, 24),
    ("ED-ASSESSMENT", "assessment", 3, 1),
]


def fixture_identity(fixture, seed=41021, days=365):
    return f"demo-v{GENERATOR_VERSION.replace('.', '-')}-{fixture}-{seed}-{days}"


def generate_dataset(fixture="planning_baseline", seed=41021, days=365):
    if fixture not in ("planning_baseline", "stress_snapshot"):
        raise ValueError("Unknown fixture")
    if not 1 <= int(days) <= 365:
        raise ValueError("days must be between 1 and 365")
    t0 = dt(T0)
    z = ZoneInfo(ZONE)
    local0 = t0.astimezone(z)
    version = fixture_identity(fixture, seed, days)
    data = {
        "id": version,
        "dataset_version_id": version,
        "organization_id": "ORG-DEMO",
        "schema_version": "1.0",
        "fixture": fixture,
        "synthetic": True,
        "snapshot_at": T0,
        "timezone": ZONE,
        "seed": seed,
        "generator_seed": seed,
        "generator_version": GENERATOR_VERSION,
        "label": f"{fixture.replace('_', ' ').title()}",
        "historical_census_linkage": "independent_demo_snapshot",
        "workspace_id": "workspace-demo",
    }
    data["organizations"] = [{"organization_id": "ORG-DEMO", "name": "Synthetic Hospital Operator"}]
    data["facilities"] = [
        {
            "facility_id": "FAC-" + sid,
            "id": "FAC-" + sid,
            "organization_id": "ORG-DEMO",
            "name": "Demo " + name,
            "kind": kind,
            "latitude": lat,
            "longitude": lon,
            "location_quality": "synthetic_approximate",
            "status": status,
            "capabilities": {
                "hospital": ["WARD_CARE", "ICU_CARE"] + (["ED_CARE"] if sid == "MAIN" else []),
                "clinic": ["CLINIC_CARE"],
                "ward_overflow": ["WARD_CARE"],
                "shelter": ["SHELTER_ONLY"],
            }[kind],
            "activation_minutes": activation,
            "acceptance_mode": "internal" if sid not in ("EAST", "WEST") else "synthetic_auto",
            "synthetic": True,
        }
        for sid, name, kind, lat, lon, status, activation in SITES
    ]
    data["capacity_policies"] = []
    for kind, ratio, provider in [
        ("ward", 4, 1),
        ("icu", 2, 1),
        ("ed", 4, 2),
        ("clinic", 4, 1),
        ("shelter", 1, 0),
    ]:
        data["capacity_policies"].append(
            {
                "capacity_policy_id": "POL-" + kind.upper(),
                "unit_kind": kind,
                "nurse_capability": kind.upper() + "_NURSING",
                "slots_per_nurse": ratio,
                "minimum_provider_count": provider,
                "minimum_support_count": int(kind != "shelter"),
                "per_slot_resources": [{"capability_code": "ICU_MONITOR", "quantity": 1}]
                if kind == "icu"
                else [],
                "allowed_patient_care_levels": [
                    {"ed": "ambulatory", "clinic": "ambulatory", "shelter": "nonclinical"}.get(kind, kind)
                ],
                "is_demonstration_assumption": True,
            }
        )
    data["units"] = []
    data["slots"] = []
    data["geometry"] = []
    positions = [(0.15, 0.15), (0.15, 0.42), (0.15, 0.69), (0.60, 0.15), (0.60, 0.58)]
    for n, (uid, sid, kind, physical, staffed, background, rn, provider, support) in enumerate(UNITS):
        uid = "UNIT-" + uid
        facility = "FAC-" + sid
        installed = physical
        count = 20 if sid == "OVERFLOW-SOUTH" else physical
        enabled = physical if sid not in ("CLINIC-NORTH", "OVERFLOW-SOUTH") else 0
        unit = {
            "unit_id": uid,
            "id": uid,
            "facility_id": facility,
            "name": uid.removeprefix("UNIT-").replace("-", " ").title(),
            "kind": kind,
            "physical_capacity": physical,
            "enabled_capacity": enabled,
            "staffed_capacity": staffed,
            "capacity_policy_id": "POL-" + kind.upper(),
            "capabilities": [("SHELTER_ONLY" if kind == "shelter" else kind.upper() + "_CARE")],
            "background_occupied": background,
            "capacity_mode": "advertised_aggregate"
            if sid in ("EAST", "WEST", "SHELTER-WEST")
            else "staff_derived",
            "advertised_staffed_capacity": staffed if sid in ("EAST", "WEST", "SHELTER-WEST") else None,
            "turnover_minutes": {"ward": 30, "icu": 45, "ed": 15, "clinic": 10, "shelter": 0}[kind],
            "baseline_staff": {"rn": rn, "provider": provider, "support": support},
        }
        data["units"].append(unit)
        if n < 5:
            x, y = positions[n]
            w, h = 0.30, 0.20
        elif sid in ("EAST", "WEST"):
            x, y = (0.10, 0.25) if kind == "ward" else (0.55, 0.25)
            w, h = (0.35, 0.40) if kind == "ward" else (0.30, 0.40)
        else:
            x, y, w, h = 0.2, 0.2, 0.6, 0.6
        data["geometry"].append(
            {
                "unit_id": uid,
                "facility_id": facility,
                "x": x,
                "y": y,
                "width": w,
                "height": h,
                "label": unit["name"],
            }
        )
        columns = int(np.ceil(np.sqrt(count)))
        prefix = {
            "UNIT-WARD-A": "WA",
            "UNIT-WARD-B": "WB",
            "UNIT-WARD-C": "WC",
            "UNIT-ED": "ED",
            "UNIT-ICU": "ICU",
        }.get(uid, uid.removeprefix("UNIT-"))
        for i in range(count):
            data["slots"].append(
                {
                    "slot_id": f"SLOT-{prefix}-{i + 1:03}",
                    "unit_id": uid,
                    "slot_kind": {
                        "ward": "ward_bed",
                        "icu": "icu_bed",
                        "ed": "ed_bay",
                        "clinic": "clinic_space",
                        "shelter": "shelter_space",
                    }[kind],
                    "enabled": bool(i < enabled),
                    "installation_status": "installed" if i < installed else "planned",
                    "capabilities": unit["capabilities"],
                    "display_label": str(i + 1),
                    "layout_x": (i % columns + 1) / (columns + 1),
                    "layout_y": (i // columns + 1) / (int(np.ceil(count / columns)) + 1),
                }
            )
    data["unit_layouts"] = data["geometry"]
    data["virtual_locations"] = [
        {
            "location_id": k,
            "facility_id": "FAC-MAIN",
            "kind": "reserve_depot" if k == "RESERVE-MAIN" else "waiting_zone",
            "label": label,
            "layout_x": x,
            "layout_y": y,
        }
        for k, label, x, y in [
            ("QUEUE-ED", "ED waiting", 0.85, 0.84),
            ("QUEUE-DIRECT-WARD", "Direct admission waiting", 0.5, 0.9),
            ("RESERVE-MAIN", "Reserve depot", 0.85, 0.4),
        ]
    ]
    data["staff"] = []
    team_staff = {}
    for team in range(4):
        members = []
        for uid, sid, kind, physical, staffed, background, rn, providers, support in UNITS[:5]:
            for role, count in [("rn", rn), ("provider", providers), ("support", support)]:
                for j in range(count):
                    sid = f"STAFF-T{team + 1}-{uid}-{role.upper()}-{j + 1:02}"
                    capability = (
                        "GENERAL_SUPPORT"
                        if role == "support"
                        else kind.upper() + ("_NURSING" if role == "rn" else "_PROVIDER")
                    )
                    row = {
                        "staff_id": sid,
                        "role": role,
                        "capabilities": [capability],
                        "team_id": f"TEAM-{team + 1}",
                        "employment_pool": "hospital",
                        "home_unit_id": "UNIT-" + uid,
                    }
                    data["staff"].append(row)
                    members.append(row)
        for role, count in [("rn", 5), ("provider", 1), ("support", 1)]:
            for j in range(count):
                cap = (
                    ["GENERAL_SUPPORT"]
                    if role == "support"
                    else [a + ("_NURSING" if role == "rn" else "_PROVIDER") for a in ["WARD", "CLINIC"]]
                )
                row = {
                    "staff_id": f"STAFF-RES-T{team + 1}-{role.upper()}-{j + 1:02}",
                    "role": role,
                    "capabilities": cap,
                    "team_id": f"RESERVE-TEAM-{team + 1}",
                    "employment_pool": "reserve",
                    "home_unit_id": None,
                }
                data["staff"].append(row)
                members.append(row)
        team_staff[team] = members
    assignments = []
    for day in range(-1, int(days)):
        for hour in (7, 19):
            if day == -1 and hour == 7:
                continue
            start = (local0 + timedelta(days=day)).replace(hour=hour)
            end = start + timedelta(hours=12)
            target_phase = (0, 1) if hour == 7 else (2, 3)
            team = next(t for t in range(4) if (day + 2 * t) % 8 in target_phase)
            for staff in team_staff[team]:
                assignments.append(
                    {
                        "assignment_id": f"ASG-{len(assignments) + 1:06}",
                        "staff_id": staff["staff_id"],
                        "unit_id": staff["home_unit_id"],
                        "reserve_pool_id": "RESERVE-MAIN" if staff["employment_pool"] == "reserve" else None,
                        "start_at": iso(start),
                        "end_at": iso(end),
                        "status": "scheduled",
                        "allocation_fraction": 1.0,
                    }
                )
    data["assignments"] = assignments
    data["staff_assignments"] = assignments
    pools = [
        ("ICU-MONITOR", "UNIT-ICU", "ICU_MONITOR", 16, False),
        ("ICU-VENT", "UNIT-ICU", "VENTILATOR", 6, False),
        ("WARD-O2-A", "UNIT-WARD-A", "WARD_OXYGEN", 16, False),
        ("WARD-O2-B", "UNIT-WARD-B", "WARD_OXYGEN", 16, False),
        ("WARD-O2-C", "UNIT-WARD-C", "WARD_OXYGEN", 8, False),
        ("ED-MONITOR", "UNIT-ED", "ED_MONITOR", 16, False),
        ("RES-MONITOR", None, "ICU_MONITOR", 8, True),
        ("RES-O2", None, "WARD_OXYGEN", 8, True),
        ("RES-CLINIC-KIT", None, "CLINIC_KIT", 12, True),
    ]
    data["equipment_pools"] = [
        {
            "equipment_pool_id": "EQ-" + pid,
            "capability_code": cap,
            "facility_id": "FAC-MAIN",
            "unit_id": unit,
            "quantity": count,
            "unserviceable_quantity": 0,
            "portable": portable,
            "setup_minutes": 30 if portable else 0,
        }
        for pid, unit, cap, count, portable in pools
    ]
    data["partner_equipment"] = [
        {
            "advertisement_id": f"PE-{site}-{cap}",
            "facility_id": "FAC-" + site,
            "unit_id": f"UNIT-{site}-" + ("WARD" if cap == "WARD_OXYGEN" else "ICU"),
            "capability_code": cap,
            "quantity": count,
        }
        for site in ["EAST", "WEST"]
        for cap, count in [("WARD_OXYGEN", 2), ("ICU_MONITOR", 1), ("VENTILATOR", 0)]
    ]
    data["los_templates"] = [
        {
            "template_id": key,
            "purpose": purpose,
            "family": "gamma",
            "shape": shape,
            "scale_hours": scale,
            "minimum_minutes": 30,
            "synthetic": True,
            "description": key,
        }
        for key, purpose, shape, scale in TEMPLATES
    ] + [
        {
            "template_id": "CLINIC-SERVICE",
            "purpose": "clinic_service",
            "family": "fixed",
            "fixed_minutes": 90,
            "minimum_minutes": 30,
            "synthetic": True,
            "description": "Synthetic ambulatory service",
        }
    ]
    data["distributions"] = data["los_templates"]
    data["cohorts"] = []
    for care, mixes in [
        ("ward", [("SHORT", 0.4), ("STANDARD", 0.45), ("EXTENDED", 0.15)]),
        ("icu", [("STANDARD", 0.85), ("EXTENDED", 0.15)]),
    ]:
        for name, weight in mixes:
            data["cohorts"].append(
                {
                    "cohort_id": f"COHORT-{care.upper()}-{name}",
                    "care_level": care,
                    "los_template_id": f"LOS-{care.upper()}-{name}",
                    "selection_weight": weight,
                    "resource_profile_weights": [
                        {"resource_profile_id": "RP-WARD-BASIC", "weight": 0.75},
                        {"resource_profile_id": "RP-WARD-OXYGEN", "weight": 0.25},
                    ]
                    if care == "ward"
                    else [
                        {"resource_profile_id": "RP-ICU-MONITORED", "weight": 2 / 3},
                        {"resource_profile_id": "RP-ICU-VENTILATED", "weight": 1 / 3},
                    ],
                    "transfer_eligibility": True,
                }
            )
    data["cohorts"].append(
        {
            "cohort_id": "COHORT-ED",
            "care_level": "ambulatory",
            "assessment_template_id": "ED-ASSESSMENT",
            "selection_weight": 1,
            "resource_profile_weights": [
                {"resource_profile_id": "RP-ED-BASIC", "weight": 0.864},
                {"resource_profile_id": "RP-ED-MONITORED", "weight": 0.136},
            ],
            "transfer_eligibility": False,
        }
    )
    profs = [
        ("ED-BASIC", "ed", [], None),
        ("ED-MONITORED", "ed", ["ED_MONITOR"], "ADVANCED_TRANSPORT"),
        ("WARD-BASIC", "ward", [], "BASIC_TRANSPORT"),
        ("WARD-OXYGEN", "ward", ["WARD_OXYGEN"], "ADVANCED_TRANSPORT"),
        ("ICU-MONITORED", "icu", ["ICU_MONITOR"], "ADVANCED_TRANSPORT"),
        ("ICU-VENTILATED", "icu", ["ICU_MONITOR", "VENTILATOR"], "ADVANCED_TRANSPORT"),
        ("CLINIC-BASIC", "clinic", ["CLINIC_KIT"], "BASIC_TRANSPORT"),
    ]
    data["resource_profiles"] = [
        {
            "resource_profile_id": "RP-" + pid,
            "name": pid,
            "stage_kind": kind,
            "required_site_capability": kind.upper() + "_CARE",
            "required_equipment": [{"capability_code": c, "quantity": 1} for c in eq],
            "allowed_unit_kinds": [kind],
            "transfer_allowed": kind in ("ward", "icu"),
            "required_transport_capability": transport,
            "synthetic": True,
        }
        for pid, kind, eq, transport in profs
    ]
    data["capabilities"] = [
        {
            "capability_code": c,
            "kind": k,
            "label": c.replace("_", " ").title(),
            "description": "Synthetic simulation capability",
        }
        for k, codes in [
            ("care", ["ED_CARE", "WARD_CARE", "ICU_CARE", "CLINIC_CARE", "SHELTER_ONLY"]),
            (
                "staff",
                [
                    "WARD_NURSING",
                    "ICU_NURSING",
                    "ED_NURSING",
                    "CLINIC_NURSING",
                    "WARD_PROVIDER",
                    "ICU_PROVIDER",
                    "ED_PROVIDER",
                    "CLINIC_PROVIDER",
                    "GENERAL_SUPPORT",
                ],
            ),
            ("equipment", ["ICU_MONITOR", "VENTILATOR", "WARD_OXYGEN", "ED_MONITOR", "CLINIC_KIT"]),
            ("transport", ["BASIC_TRANSPORT", "ADVANCED_TRANSPORT"]),
        ]
        for c in codes
    ]
    baseline = {
        "baseline_id": "BASELINE-DEMO",
        "ed_arrivals_per_local_day": 100,
        "direct_ward_arrivals_per_local_day": 4,
        "hour_weights": HOURS,
        "weekday_weights": WEEKDAYS,
        "ed_admission_probability": 0.2,
        "icu_fraction_of_admissions": 0.2,
        "cohort_mix": {"ward": [0.4, 0.45, 0.15], "icu": [0.85, 0.15]},
        "method": "configured",
    }
    data["arrival_profiles"] = baseline
    data["baseline"] = baseline
    data["entry_streams"] = [
        {
            "entry_stream_id": "ED_MAIN",
            "entry_type": "ed",
            "destination_facility_id": "FAC-MAIN",
            "enabled": True,
            "baseline_id": "BASELINE-DEMO",
            "expected_arrivals_per_local_day": 100,
            "hour_weights": HOURS,
            "weekday_weights": WEEKDAYS,
            "disposition_weights": {"discharge": 0.8, "ward": 0.16, "icu": 0.04},
            "assessment_template_id": "ED-ASSESSMENT",
            "clinic_eligibility_probability_given_discharge": 0.375,
            "initial_queue_location_id": "QUEUE-ED",
        },
        {
            "entry_stream_id": "DIRECT_WARD_MAIN",
            "entry_type": "direct_ward",
            "destination_facility_id": "FAC-MAIN",
            "enabled": True,
            "baseline_id": "BASELINE-DEMO",
            "expected_arrivals_per_local_day": 4,
            "hour_weights": HOURS,
            "weekday_weights": WEEKDAYS,
            "disposition_weights": {"ward": 1},
            "assessment_template_id": None,
            "clinic_eligibility_probability_given_discharge": 0,
            "initial_queue_location_id": "QUEUE-DIRECT-WARD",
        },
    ]
    data["clinic_policies"] = [
        {
            "clinic_policy_id": "CLINIC-POLICY",
            "site_id": "FAC-CLINIC-NORTH",
            "service_template_id": "CLINIC-SERVICE",
            "eligibility_tag": "eligible_for_clinic_diversion",
            "routing_mode": "new_arrivals_only",
            "hospital_fallback": True,
            "transport_required": False,
            "admission_start_at": T0,
            "admission_end_at": iso(endpoint(T0, days)),
            "drain_after_close": True,
        }
    ]
    data["pathway_profiles"] = [
        {
            "pathway_profile_id": "PATH-" + s["entry_stream_id"],
            "entry_stream_id": s["entry_stream_id"],
            "ward_cohort_weights": [0.4, 0.45, 0.15],
            "icu_cohort_weights": [0.85, 0.15],
            "icu_stepdown_probability": 0,
            "clinic_policy_id": "CLINIC-POLICY",
        }
        for s in data["entry_streams"]
    ]
    patients = []
    prefix = "PAT-PLAN-" if fixture == "planning_baseline" else "PAT-STRESS-"

    def patient(unit, care, cohort, state="inpatient", equipment=(), remaining=True):
        idx = len(patients) + 1
        prng = rng(seed, "census", fixture, idx)
        pid = f"{prefix}{idx:06}"
        arrived = t0 - timedelta(minutes=int(prng.integers(12 * 60, 7 * 1440)))
        entered = arrived + timedelta(minutes=60)
        slots = [s for s in data["slots"] if s["unit_id"] == unit]
        slot = slots[sum(p["unit_id"] == unit for p in patients)]["slot_id"]
        p = {
            "patient_id": pid,
            "facility_id": "FAC-MAIN",
            "unit_id": unit,
            "slot_id": slot,
            "state": state,
            "care_level": care,
            "acuity_rank": {"ward": 3, "icu": 1, "ambulatory": 4}[care],
            "arrival_at": iso(arrived),
            "unit_entered_at": iso(entered),
            "admission_requested_at": iso(arrived + timedelta(minutes=30)) if state == "inpatient" else None,
            "admitted_at": iso(entered) if state == "inpatient" else None,
            "target_unit_kind": None,
            "cohort_template_id": cohort,
            "resource_requirements": [{"capability_code": e, "quantity": 1} for e in equipment],
            "eligible_for_transfer": care in ("ward", "icu"),
            "eligible_for_clinic_diversion": False,
            "needs_advanced_transport": bool(equipment),
            "entry_type": "ed",
            "source_type": "initial_census",
            "stage_status": "in_service" if state != "ed_boarding" else "not_started",
            "state_entered_at": iso(entered),
            "current_stage_started_at": iso(entered),
            "queue_location_id": None,
            "queue_entered_at": None,
            "tags": [],
        }
        if state == "inpatient":
            p["remaining_stage_spec"] = {
                "kind": "remaining_distribution",
                "distribution_id": cohort.replace("COHORT", "RES"),
            }
            p["remaining_stay_template_id"] = cohort.replace("COHORT", "RES")
        elif state == "ed_boarding":
            p["admission_requested_at"] = iso(t0 - timedelta(minutes=int(prng.integers(60, 481))))
            p["queue_entered_at"] = p["admission_requested_at"]
            p["state_entered_at"] = p["admission_requested_at"]
            p["target_unit_kind"] = care
            p["current_stage_started_at"] = None
        else:
            p["assessment_remaining_minutes"] = int(prng.integers(30, 240))
            p["remaining_stage_spec"] = {
                "kind": "fixed_minutes",
                "minutes": p["assessment_remaining_minutes"],
            }
            p["unit_entered_at"] = iso(t0 - timedelta(minutes=int(prng.integers(1, 120))))
            p["current_stage_started_at"] = p["unit_entered_at"]
            p["state_entered_at"] = p["unit_entered_at"]
        patients.append(p)

    mixes = (
        [(10, 10, 6), (10, 10, 5), (5, 5, 3)]
        if fixture == "planning_baseline"
        else [(13, 13, 6), (13, 13, 6), (6, 6, 4)]
    )
    for unit, mix, oxygen in zip(
        ["UNIT-WARD-A", "UNIT-WARD-B", "UNIT-WARD-C"],
        mixes,
        [6, 6, 3] if fixture == "planning_baseline" else [8, 8, 4],
    ):
        k = 0
        for cohort, count in zip(["SHORT", "STANDARD", "EXTENDED"], mix):
            for i in range(count):
                patient(
                    unit, "ward", "COHORT-WARD-" + cohort, equipment=["WARD_OXYGEN"] if k < oxygen else []
                )
                k += 1
    icu = 8 if fixture == "planning_baseline" else 12
    vents = 2 if icu == 8 else 4
    for i in range(icu):
        patient(
            "UNIT-ICU",
            "icu",
            "COHORT-ICU-" + ("STANDARD" if i < (6 if icu == 8 else 8) else "EXTENDED"),
            equipment=["ICU_MONITOR"] + (["VENTILATOR"] if i < vents else []),
        )
    if fixture == "stress_snapshot":
        for cohort, count in [("SHORT", 4), ("STANDARD", 4), ("EXTENDED", 2)]:
            for i in range(count):
                patient("UNIT-ED", "ward", "COHORT-WARD-" + cohort, state="ed_boarding")
        for i in range(4):
            patient(
                "UNIT-ED",
                "icu",
                "COHORT-ICU-" + ("STANDARD" if i < 3 else "EXTENDED"),
                state="ed_boarding",
                equipment=["ED_MONITOR"],
            )
    for i in range(12 if fixture == "planning_baseline" else 10):
        patient(
            "UNIT-ED",
            "ambulatory",
            "COHORT-ED",
            state="ed_assessment",
            equipment=["ED_MONITOR"] if i < 2 else [],
        )
    data["patients"] = patients
    matrix = [
        [0, 8, 11, 7, 9, 14],
        [9, 0, 18, 10, 13, 20],
        [12, 17, 0, 14, 12, 6],
        [8, 11, 14, 0, 16, 18],
        [10, 14, 13, 17, 0, 18],
        [15, 21, 7, 18, 17, 0],
    ]
    data["routes"] = [
        {
            "route_id": f"ROUTE-{SITES[i][0]}-{SITES[j][0]}",
            "from_facility_id": "FAC-" + SITES[i][0],
            "to_facility_id": "FAC-" + SITES[j][0],
            "travel_minutes": matrix[i][j],
            "loading_minutes": 10,
            "unloading_minutes": 10,
            "estimate_source": "synthetic",
            "effective_at": T0,
        }
        for i in range(6)
        for j in range(6)
        if i != j
    ]
    data["vehicles"] = [
        {
            "vehicle_id": vid,
            "home_facility_id": "FAC-MAIN",
            "capabilities": ["BASIC_TRANSPORT"] + (["ADVANCED_TRANSPORT"] if vid == "VEH-ADV-1" else []),
            "patient_capacity": 1,
            "available_from": T0,
            "available_until": None,
            "turnaround_minutes": 10,
        }
        for vid in ["VEH-BASIC-1", "VEH-BASIC-2", "VEH-ADV-1"]
    ]
    history_rng = rng(seed, "history")
    history = []
    historical_days = [local0 - timedelta(days=90 - i) for i in range(90)]
    day_weights = np.array([WEEKDAYS[d.weekday()] for d in historical_days])
    day_weights /= sum(day_weights)
    dispositions = ["discharge"] * 7200 + ["ward"] * 1440 + ["icu"] * 360
    history_rng.shuffle(dispositions)
    di = 0
    for entry, total in [("ed", 9000), ("direct_ward", 360)]:
        for day, count in zip(historical_days, history_rng.multinomial(total, day_weights)):
            for j in range(int(count)):
                hour = int(history_rng.choice(24, p=HOURS))
                arrival = day.replace(hour=hour) + timedelta(seconds=int(history_rng.integers(0, 3600)))
                care = dispositions[di] if entry == "ed" else "ward"
                di += int(entry == "ed")
                assessment = (
                    arrival + timedelta(minutes=max(30, round(float(history_rng.gamma(3, 60)))))
                    if entry == "ed"
                    else None
                )
                admitted = (assessment or arrival) if care != "discharge" else None
                cohort_id = "COHORT-ED"
                if admitted:
                    options = [c for c in data["cohorts"] if c["care_level"] == care]
                    cohort = options[
                        int(history_rng.choice(len(options), p=[c["selection_weight"] for c in options]))
                    ]
                    cohort_id = cohort["cohort_id"]
                    template = next(
                        t for t in data["los_templates"] if t["template_id"] == cohort["los_template_id"]
                    )
                    departure = admitted + timedelta(
                        minutes=max(
                            30,
                            round(float(history_rng.gamma(template["shape"], template["scale_hours"] * 60))),
                        )
                    )
                else:
                    departure = assessment
                history.append(
                    {
                        "episode_id": f"HIST-{len(history) + 1:06}",
                        "arrival_at": iso(arrival),
                        "entry_type": entry,
                        "assessment_end_at": iso(assessment) if assessment else None,
                        "admitted_at": iso(admitted) if admitted else None,
                        "care_level": "ambulatory" if care == "discharge" else care,
                        "departure_at": iso(departure),
                        "cohort_id": cohort_id,
                        "censored": dt(departure) >= t0,
                    }
                )
    data["history"] = history
    daily_history = {
        d.date().isoformat(): {
            "local_date": d.date().isoformat(),
            "ed_arrivals": 0,
            "direct_admissions": 0,
            "ward_admissions": 0,
            "icu_admissions": 0,
            "ed_admissions": 0,
        }
        for d in historical_days
    }
    for h in history:
        row = daily_history[dt(h["arrival_at"]).astimezone(z).date().isoformat()]
        row["ed_arrivals" if h["entry_type"] == "ed" else "direct_admissions"] += 1
        if h["admitted_at"]:
            row[h["care_level"] + "_admissions"] += 1
            if h["entry_type"] == "ed":
                row["ed_admissions"] += 1
    data["historical_daily_summaries"] = list(daily_history.values())
    data["hour_of_day_baseline"] = [{"hour": i, "weight": weight} for i, weight in enumerate(HOURS)]
    data["weekday_baseline"] = [{"weekday": i, "multiplier": weight} for i, weight in enumerate(WEEKDAYS)]
    data["presets"] = [
        {"preset_id": "PRESET-" + key, "name": name, "conditions": conditions}
        for key, name, conditions in [
            ("BASELINE", "Baseline", []),
            (
                "SUSTAINED-70",
                "Sustained 70% surge",
                [
                    {
                        "kind": "arrival_multiplier",
                        "entry_stream_id": "ED_MAIN",
                        "surge_percent": 70,
                        "shape": "step",
                    }
                ],
            ),
            (
                "WAVE-70",
                "Wave 70% surge",
                [
                    {
                        "kind": "arrival_multiplier",
                        "entry_stream_id": "ED_MAIN",
                        "surge_percent": 70,
                        "shape": "wave",
                    }
                ],
            ),
            (
                "PULSE",
                "Short arrival pulse",
                [
                    {
                        "kind": "arrival_batch",
                        "entry_stream_id": "ED_MAIN",
                        "at": iso(local0 + timedelta(days=1, hours=12)),
                        "count": 20,
                        "spread_minutes": 60,
                        "care_mix": {"discharge": 0.8, "ward": 0.16, "icu": 0.04},
                    }
                ],
            ),
            (
                "STAFF-LOSS",
                "Staff loss",
                [
                    {
                        "kind": "staff_unavailability",
                        "unit_id": "UNIT-WARD-A",
                        "count": 2,
                        "start_at": iso(local0 + timedelta(days=4)),
                        "end_at": iso(local0 + timedelta(days=7)),
                    }
                ],
            ),
            (
                "COMBINED",
                "Surge and staff loss",
                [
                    {
                        "kind": "arrival_multiplier",
                        "entry_stream_id": "ED_MAIN",
                        "surge_percent": 70,
                        "shape": "step",
                    },
                    {
                        "kind": "staff_unavailability",
                        "unit_id": "UNIT-WARD-A",
                        "count": 2,
                        "start_at": iso(local0 + timedelta(days=4)),
                        "end_at": iso(local0 + timedelta(days=7)),
                    },
                ],
            ),
        ]
    ]
    data["intervention_templates"] = [
        {"template_kind": k, "kind": kind, "name": name, "activation_minutes": delay}
        for k, kind, name, delay in [
            ("staff_existing_beds", "staff_existing", "Staff 20 existing ward beds", 0),
            ("partner_transfer", "partner_transfer", "Partner transfer", 0),
            ("activate_clinic", "clinic", "Activate clinic", 360),
            ("activate_overflow", "staffed_overflow", "Activate staffed overflow", 720),
        ]
    ]
    data["update_fixtures"] = [
        {
            "update_id": f"UPDATE-{i + 1}",
            "type": kind,
            "effective_at": iso(local0 + timedelta(days=i + 1, hours=12)),
            "recorded_at": T0,
            "state_origin": "simulation_branch",
            "source": "synthetic",
            "idempotency_key": f"fixture-{i + 1}",
            "status": "active",
            "payload": payload,
        }
        for i, (kind, payload) in enumerate(
            [
                (
                    "arrival_batch",
                    {
                        "facility_id": "FAC-MAIN",
                        "entry_stream_id": "ED_MAIN",
                        "count": 20,
                        "spread_minutes": 60,
                        "care_mix": {"discharge": 0.8, "ward": 0.16, "icu": 0.04},
                    },
                ),
                (
                    "staff_unavailable",
                    {"unit_id": "UNIT-WARD-A", "count": 2, "until": iso(local0 + timedelta(days=3))},
                ),
                ("site_ready", {"facility_id": "FAC-CLINIC-NORTH", "enabled_slots": 8}),
                (
                    "advertised_capacity_change",
                    {
                        "unit_id": "UNIT-EAST-WARD",
                        "advertised_staffed_capacity": 22,
                        "reason": "Synthetic change",
                    },
                ),
                (
                    "retract_or_correct",
                    {
                        "referenced_update_id": "UPDATE-1",
                        "reason": "Count corrected",
                        "replacement_payload": {
                            "facility_id": "FAC-MAIN",
                            "entry_stream_id": "ED_MAIN",
                            "count": 12,
                            "spread_minutes": 60,
                            "care_mix": {"discharge": 0.8, "ward": 0.16, "icu": 0.04},
                        },
                    },
                ),
            ]
        )
    ]
    data["assumptions"] = [
        "All people, resources, staffing ratios, durations, travel and site capabilities are synthetic engineering fixtures.",
        "History and current census are independent; no longitudinal linkage is claimed.",
        "ICU step-down probability is zero.",
        "Reserve equipment setup is 30 minutes, included in site activation.",
        "Direct-admission waiting uses an unmodeled holding queue.",
        "Financial costs are not configured.",
    ]
    alias = {"staff_assignments", "unit_layouts", "distributions", "baseline"}
    files = [
        {"name": key + ".json", "row_count": len(value), "sha256": digest(value)}
        for key, value in data.items()
        if isinstance(value, list) and key not in alias
    ]
    data["manifest"] = {
        "dataset_version_id": version,
        "schema_version": "1.0",
        "snapshot_at": T0,
        "timezone": ZONE,
        "synthetic": True,
        "generator_seed": seed,
        "generator_version": GENERATOR_VERSION,
        "historical_census_linkage": "independent_demo_snapshot",
        "files": files,
        "counts": {f["name"].removesuffix(".json"): f["row_count"] for f in files},
        "coverage_days": days,
    }
    data["input_sha256"] = digest(data)
    return data
