import assert from "node:assert/strict";
import test from "node:test";

import { buildGradeAdjustedPaceReport, minettiCost } from "./gap.js";

const START = Date.parse("2026-07-31T09:00:00.000Z");

test("flat running GAP matches raw pace", () => {
  const analysis = runningAnalysis(recordsForGrade(0));
  const report = buildGradeAdjustedPaceReport(analysis);

  assert.equal(report.source, "app-estimated");
  assert.equal(report.algorithmVersion, "gwr-minetti-2002-v1");
  assert.ok(Math.abs(report.activity.gapSecondsPerKm - report.activity.rawPaceSecondsPerKm) < 0.1);
  assert.equal(report.activity.gradeCoveragePercent, 100);
});

test("uphill GAP is faster than raw pace by the Minetti cost ratio", () => {
  const report = buildGradeAdjustedPaceReport(runningAnalysis(recordsForGrade(0.05)));
  const expected = report.activity.rawPaceSecondsPerKm / (minettiCost(0.05) / minettiCost(0));

  assert.ok(report.activity.gapSecondsPerKm < report.activity.rawPaceSecondsPerKm);
  assert.ok(Math.abs(report.activity.gapSecondsPerKm - expected) < 0.2);
});

test("downhill GAP is slower than raw pace", () => {
  const report = buildGradeAdjustedPaceReport(runningAnalysis(recordsForGrade(-0.05)));

  assert.ok(report.activity.gapSecondsPerKm > report.activity.rawPaceSecondsPerKm);
});

test("local grade affects a net-zero rolling route", () => {
  const records = recordsForProfile((distance) => distance <= 150
    ? distance * 0.05
    : 7.5 - ((distance - 150) * 0.05));
  const report = buildGradeAdjustedPaceReport(runningAnalysis(records));

  assert.equal(records.at(-1).enhancedAltitude, 0);
  assert.notEqual(report.activity.gapSecondsPerKm, report.activity.rawPaceSecondsPerKm);
  assert.ok(report.activity.gradeCoveragePercent > 95);
});

test("reports GAP for individual running laps and 30-second buckets", () => {
  const records = recordsForGrade(0.04, 201);
  const analysis = runningAnalysis(records, [
    lap(0, 100, 300),
    lap(100, 200, 300),
  ]);
  const report = buildGradeAdjustedPaceReport(analysis);

  assert.equal(report.laps.length, 2);
  assert.ok(report.laps.every((item) => item.gapSecondsPerKm < item.rawPaceSecondsPerKm));
  assert.ok(report.timeSeries.length >= 6);
  assert.ok(report.timeSeries.every((item) => Number.isFinite(item.gapSecondsPerKm)));
});

test("falls back to FIT record grade when elevation is absent", () => {
  const records = recordsForGrade(0.03).map(({ enhancedAltitude, ...record }) => ({
    ...record,
    grade: 3,
  }));
  const report = buildGradeAdjustedPaceReport(runningAnalysis(records));

  assert.equal(report.gradeSource, "fit-record-grade");
  assert.equal(report.activity.gradeSource, "fit-record-grade");
  assert.ok(report.activity.gapSecondsPerKm < report.activity.rawPaceSecondsPerKm);
});

test("reports GAP for sequential distance-based workout blocks", () => {
  const analysis = runningAnalysis(recordsForGrade(0.03, 201));
  analysis.workoutSteps = [
    { messageIndex: 0, durationType: "distance", durationDistance: 300, intensity: "warmup" },
    { messageIndex: 1, durationType: "distance", durationDistance: 300, intensity: "active" },
  ];
  const report = buildGradeAdjustedPaceReport(analysis);

  assert.deepEqual(report.workoutBlocks.map((block) => block.plannedDistanceMeters), [300, 300]);
  assert.deepEqual(report.workoutBlocks.map((block) => block.intensity), ["warmup", "active"]);
  assert.ok(report.workoutBlocks.every((block) => block.gapSecondsPerKm < block.rawPaceSecondsPerKm));
});

test("does not add GAP to non-running activities", () => {
  const analysis = runningAnalysis(recordsForGrade(0));
  analysis.summary.sport = "cycling";
  analysis.sessions[0].sport = "cycling";

  assert.equal(buildGradeAdjustedPaceReport(analysis), null);
});

function recordsForGrade(grade, count = 101) {
  return recordsForProfile((distance) => distance * grade, count);
}

function recordsForProfile(elevationAtDistance, count = 101) {
  return Array.from({ length: count }, (_, index) => {
    const distance = index * 3;
    return {
      timestamp: new Date(START + (index * 1000)).toISOString(),
      distance,
      enhancedSpeed: 3,
      enhancedAltitude: elevationAtDistance(distance),
    };
  });
}

function runningAnalysis(records, laps = [lap(0, records.length - 1, (records.length - 1) * 3)]) {
  const duration = records.length - 1;
  return {
    summary: { sport: "running" },
    records,
    sessions: [{
      sport: "running",
      startTime: new Date(START).toISOString(),
      timestamp: new Date(START).toISOString(),
      totalElapsedTime: duration,
      totalDistance: duration * 3,
    }],
    laps,
  };
}

function lap(startSecond, endSecond, distance) {
  return {
    startTime: new Date(START + (startSecond * 1000)).toISOString(),
    timestamp: new Date(START + (startSecond * 1000)).toISOString(),
    totalElapsedTime: endSecond - startSecond,
    totalDistance: distance,
  };
}
