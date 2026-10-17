"""Resolve declared pathway, cohort and resource-profile inputs by identity."""

from __future__ import annotations

import numpy as np


def profiles(sim):
    if not hasattr(sim, "_declared_profiles"):
        sim._declared_profiles = {p["resource_profile_id"]: p for p in sim.data.get("resource_profiles", [])}
    return sim._declared_profiles


def pathway(sim, stream):
    return next((p for p in sim.data.get("pathway_profiles", []) if p["entry_stream_id"] == stream), {})


def weighted_choice(random, values, weights):
    probabilities = np.asarray(weights, dtype=float)
    if (
        not len(values)
        or len(values) != len(probabilities)
        or not np.all(np.isfinite(probabilities))
        or np.any(probabilities < 0)
        or abs(float(sum(probabilities)) - 1) > 1e-6
    ):
        raise ValueError("Declared mixture weights must be finite, nonnegative and sum to one")
    probabilities = probabilities / sum(probabilities)
    return values[int(random.choice(len(values), p=probabilities))]


def choose_cohort(sim, care, random, weights=None):
    candidates = [c for c in sim.cohorts.values() if c["care_level"] == care]
    if weights and isinstance(weights[0], dict):
        candidates = [sim.cohorts[w.get("cohort_id", w.get("cohort_template_id"))] for w in weights]
        if any(c["care_level"] != care for c in candidates):
            raise ValueError("Pathway cohort weights must match the required care level")
        values = [w["weight"] for w in weights]
    else:
        values = weights if weights is not None else [c["selection_weight"] for c in candidates]
    return weighted_choice(random, candidates, values)


def equipment(profile):
    return [r["capability_code"] for r in profile["required_equipment"] for _ in range(r.get("quantity", 1))]


def choose_profile(sim, cohort, random):
    # Reversed CDF retains the canonical oxygen/ventilation keyed draws while
    # honoring arbitrary declared IDs, quantities and mixture probabilities.
    weights = list(reversed(cohort["resource_profile_weights"]))
    return weighted_choice(
        random, [profiles(sim)[w["resource_profile_id"]] for w in weights], [w["weight"] for w in weights]
    )


def prepare_stepdown(sim, patient, path):
    if patient.get("_outcome") != "icu":
        return
    chance = float(path.get("icu_stepdown_probability", 0))
    patient["_stepdown_selected"] = bool(
        chance and sim.random(patient["patient_id"], "icu-stepdown").random() < chance
    )
    if patient["_stepdown_selected"]:
        cohort = choose_cohort(
            sim,
            "ward",
            sim.random(patient["patient_id"], "stepdown-cohort"),
            path.get("stepdown_ward_cohort_weights"),
        )
        profile = choose_profile(sim, cohort, sim.random(patient["patient_id"], "stepdown-profile"))
        patient["_stepdown_cohort"] = cohort["cohort_id"]
        patient["_stepdown_profile"] = profile["resource_profile_id"]
        patient["_stepdown_duration"] = sim.duration(
            patient["patient_id"], cohort["los_template_id"], "stepdown-inpatient"
        )


def configure_path(sim, patient, stream=None):
    pid = patient["patient_id"]
    stream = stream or next(
        (s for s in sim.data.get("entry_streams", []) if s["entry_type"] == patient.get("entry_type", "ed")),
        {},
    )
    sid = stream.get("entry_stream_id", "ED_MAIN")
    path = pathway(sim, sid)
    random = sim.random(pid, "pathway")
    exogenous = (
        patient.get("source_type") not in {"initial_census", "reported_batch", "synthetic_incident"}
        and patient.get("arrival_origin") != "synthetic_incident"
    )
    weights = stream.get("disposition_weights", {"discharge": 0.8, "ward": 0.16, "icu": 0.04})
    if (
        exogenous
        and path.get("ed_disposition_weights") is not None
        and stream.get("entry_type", "ed") == "ed"
    ):
        weights = path["ed_disposition_weights"]
    if exogenous:
        for condition in sim.conditions:
            if condition.get("entry_stream_id", "ED_MAIN") != sid or condition.get("kind") not in (
                "arrival_multiplier",
                "care_mix_override",
            ):
                continue
            points = condition.get("_points")
            lower = points[0][0] if points is not None else sim.minute(condition.get("start_at", sim.at(0)))
            upper = (
                points[-1][0]
                if points is not None
                else sim.minute(condition.get("end_at", sim.at(sim.horizon)))
            )
            override = condition.get(
                "care_mix_override",
                condition.get("weights") if condition.get("kind") == "care_mix_override" else None,
            )
            if lower <= sim.now < upper and override is not None:
                weights = override
    weights = {"discharge" if key == "ambulatory" else key: value for key, value in weights.items()}
    outcome = weighted_choice(random, list(weights), list(weights.values()))
    profile_override = None
    cohort_override = None
    if outcome not in {"discharge", "ward", "icu"}:
        if outcome in profiles(sim):
            profile_override = profiles(sim)[outcome]
            outcome = profile_override["stage_kind"]
            if outcome in {"ed", "clinic"}:
                outcome = "discharge"
        elif outcome in sim.cohorts:
            cohort_override = sim.cohorts[outcome]
            outcome = cohort_override["care_level"]
            if outcome == "ambulatory":
                outcome = "discharge"
        else:
            raise ValueError("Care mix references an unknown disposition, resource profile or cohort")
    if stream.get("entry_type") == "direct_ward" and outcome != "ward":
        raise ValueError("Direct ward stream only supports ward profiles")
    reported_profiles = stream.get("resource_profile_mix", {}).get(outcome)
    if reported_profiles:
        profile_override = weighted_choice(
            sim.random(pid, outcome + "-reported-profile"),
            [profiles(sim)[ident] for ident in reported_profiles],
            list(reported_profiles.values()),
        )
    patient["_outcome"] = outcome
    care = outcome if outcome in {"ward", "icu"} else "ambulatory"
    if care in {"ward", "icu"}:
        cohort = cohort_override or choose_cohort(sim, care, random, path.get(care + "_cohort_weights"))
        profile = profile_override or choose_profile(sim, cohort, sim.random(pid, care + "-profile"))
        patient["_cohort"] = cohort["cohort_id"]
        patient["_inpatient_duration"] = sim.duration(pid, cohort["los_template_id"], "inpatient")
        patient["_inpatient_requirements"] = equipment(profile)
        patient["_inpatient_profile_id"] = profile["resource_profile_id"]
        patient["_inpatient_priority"] = profile.get("acuity_rank", {"ward": 3, "icu": 1}[care])
    if stream.get("entry_type") == "direct_ward":
        patient["cohort_template_id"] = patient["_cohort"]
        patient["acuity_rank"] = patient["_inpatient_priority"]
        patient["eligible_for_clinic_diversion"] = False
        patient["_pathway_profile_id"] = path.get("pathway_profile_id")
        return
    ed_cohort = (
        cohort_override
        if cohort_override and care == "ambulatory"
        else choose_cohort(sim, "ambulatory", sim.random(pid, "ed-cohort"))
    )
    patient["_ed_cohort"] = ed_cohort["cohort_id"]
    ed_weights = ed_cohort["resource_profile_weights"]
    signature = {tuple(equipment(profiles(sim)[w["resource_profile_id"]])): w["weight"] for w in ed_weights}
    if profile_override and profile_override["stage_kind"] == "ed":
        ed_profile = profile_override
    elif signature == {(): 0.864, ("ED_MONITOR",): 0.136}:
        requirements = ["ED_MONITOR"] if care == "icu" or sim.random(pid, "ed-profile").random() < 0.1 else []
        ed_profile = next(
            profiles(sim)[w["resource_profile_id"]]
            for w in ed_weights
            if equipment(profiles(sim)[w["resource_profile_id"]]) == requirements
        )
    else:
        ed_profile = choose_profile(sim, ed_cohort, sim.random(pid, "ed-profile"))
    patient["_ed_requirements"] = equipment(ed_profile)
    patient["_ed_profile_id"] = ed_profile["resource_profile_id"]
    if profile_override and profile_override["stage_kind"] == "clinic":
        patient["_clinic_profile_id"] = profile_override["resource_profile_id"]
    if stream.get("entry_type", patient.get("entry_type", "ed")) == "ed":
        template = stream.get("assessment_template_id") or ed_cohort["assessment_template_id"]
        patient["_assessment_duration"] = sim.duration(pid, template, "assessment")
    patient["eligible_for_clinic_diversion"] = bool(
        outcome == "discharge"
        and sim.random(pid, "clinic-tag").random()
        < stream.get("clinic_eligibility_probability_given_discharge", 0.375)
    )
    patient["acuity_rank"] = ed_profile.get("acuity_rank", {"icu": 1, "ward": 3, "ambulatory": 4}[care])
    patient["_pathway_profile_id"] = path.get("pathway_profile_id")
    prepare_stepdown(sim, patient, path)


def apply_stage_profile(sim, patient, kind):
    ident = patient.get("_ed_profile_id" if kind == "ed" else "_inpatient_profile_id")
    profile = profiles(sim).get(ident)
    if not profile:
        return
    patient["resource_profile_id"] = ident
    patient["required_transport_capability"] = profile.get("required_transport_capability")
    if kind != "ed":
        cohort = sim.cohorts[patient.get("_cohort", patient["cohort_template_id"])]
        patient["eligible_for_transfer"] = bool(
            cohort["transfer_eligibility"]
            and profile["transfer_allowed"]
            and patient.get("_declared_transfer_eligible", True)
        )
        patient["acuity_rank"] = profile.get("acuity_rank", {"ward": 3, "icu": 1}.get(kind, 4))


def stage_profile(sim, patient, kind):
    return profiles(sim).get(patient.get("_ed_profile_id" if kind == "ed" else "_inpatient_profile_id"), {})


def compatible(sim, profile, unit):
    policy = sim.policies.get(unit.get("capacity_policy_id"), {})
    care = {"ed": "ambulatory", "clinic": "ambulatory", "shelter": "nonclinical"}.get(
        unit["kind"], unit["kind"]
    )
    if "allowed_patient_care_levels" in policy and care not in policy["allowed_patient_care_levels"]:
        return False
    if not profile:
        return True
    site = next((s for s in sim.data["facilities"] if s["facility_id"] == unit["facility_id"]), {})
    return unit["kind"] in profile["allowed_unit_kinds"] and profile["required_site_capability"] in set(
        unit.get("capabilities", [])
    ) | set(site.get("capabilities", []))


def queue_profile(sim, patient, kind):
    requirements = tuple(
        sorted(
            patient.get("_ed_requirements", [])
            if kind == "ed"
            else patient.get("_inpatient_requirements", [])
        )
    )
    profile = stage_profile(sim, patient, kind)
    key = requirements
    if profile and (
        profile["allowed_unit_kinds"] != [kind]
        or profile["required_site_capability"] != kind.upper() + "_CARE"
    ):
        key += ("profile:" + profile["resource_profile_id"],)
    if not hasattr(sim, "_queue_profile_specs"):
        sim._queue_profile_specs = {}
    sim._queue_profile_specs[(kind, key)] = (requirements, profile)
    return key


def queue_spec(sim, key, kind):
    return getattr(sim, "_queue_profile_specs", {}).get((kind, key), (key, {}))


def begin_stepdown(sim, patient):
    if (
        patient.get("care_level") != "icu"
        or not patient.get("_stepdown_selected")
        or patient.get("_stepdown_started")
    ):
        return False
    patient["_stepdown_started"] = True
    patient["_cohort"] = patient["_stepdown_cohort"]
    patient["_inpatient_profile_id"] = patient["_stepdown_profile"]
    patient["_inpatient_requirements"] = equipment(profiles(sim)[patient["_stepdown_profile"]])
    patient["_inpatient_duration"] = patient["_stepdown_duration"]
    patient["care_level"] = "ward"
    patient["target_unit_kind"] = "ward"
    patient["_awaiting_new_stage"] = True
    apply_stage_profile(sim, patient, "ward")
    patient["stage_status"] = "ready_to_exit"
    patient["admission_requested_at"] = sim.at(sim.now)
    sim.queue(patient, "ward")
    sim.transition(patient, "inpatient", patient["unit_id"], patient["slot_id"])
    sim.emit("admission_request", patient, source=patient["unit_id"], reason="icu_stepdown_to_ward")
    return True
