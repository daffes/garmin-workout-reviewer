const DEFAULT_GRADE_WINDOW_METERS = 50;
const MIN_GRADE_SPAN_METERS = 15;
const MAX_ABSOLUTE_GRADE = 0.3;
const MIN_RUNNING_SPEED_METERS_PER_SECOND = 0.3;
const MAX_RUNNING_SPEED_METERS_PER_SECOND = 12.5;
const MIN_REPORT_DISTANCE_METERS = 50;

export const GAP_ALGORITHM_VERSION = "gwr-minetti-2002-v1";

export function buildGradeAdjustedPaceReport(analysis, bucketSeconds = 30) {
  const records = Array.isArray(analysis?.records) ? analysis.records : [];
  const sessions = Array.isArray(analysis?.sessions) ? analysis.sessions : [];
  const laps = Array.isArray(analysis?.laps) ? analysis.laps : [];
  const workoutSteps = Array.isArray(analysis?.workoutSteps) ? analysis.workoutSteps : [];
  const summary = analysis?.summary || {};
  const activityIsRunning = isRunningSport(pick(summary, ["sport"]));
  const runningSessions = sessions.filter((session) => isRunningSport(pick(session, ["sport", "subSport", "sub_sport"])));

  if (!activityIsRunning && !runningSessions.length) return null;

  const prepared = prepareGapIntervals(records);
  if (!prepared.intervals.length) return null;

  const sessionRanges = runningSessions.map(segmentRange).filter(Boolean);
  const activityIntervals = sessionRanges.length
    ? prepared.intervals.filter((interval) => sessionRanges.some((range) => intervalInRange(interval, range)))
    : prepared.intervals;
  const activity = summarizeIntervals(activityIntervals);
  if (!activity) return null;

  const sessionMetrics = (runningSessions.length ? runningSessions : sessions.slice(0, 1))
    .map((session, index) => summarizeSegment(prepared.intervals, session, index))
    .filter(Boolean);
  const lapMetrics = laps
    .map((lap, index) => {
      const range = segmentRange(lap);
      const belongsToRun = activityIsRunning
        || isRunningSport(pick(lap, ["sport", "subSport", "sub_sport"]))
        || (range && sessionRanges.some((sessionRange) => rangesOverlap(range, sessionRange)));
      return belongsToRun ? summarizeSegment(prepared.intervals, lap, index) : null;
    })
    .filter(Boolean);

  return {
    schemaVersion: 1,
    source: "app-estimated",
    algorithm: "Minetti running energy-cost curve applied to smoothed local grade",
    algorithmVersion: GAP_ALGORITHM_VERSION,
    paceUnit: "secondsPerKilometer",
    gradeSource: prepared.gradeSource,
    gradeSmoothingWindowMeters: DEFAULT_GRADE_WINDOW_METERS,
    gradeLimitPercent: MAX_ABSOLUTE_GRADE * 100,
    description: "Estimated flat-equivalent pace from distance-weighted local GAP. It may differ from Garmin Connect GAP.",
    activity,
    sessions: sessionMetrics,
    laps: lapMetrics,
    workoutBlocks: summarizeDistanceWorkoutBlocks(activityIntervals, workoutSteps),
    timeSeries: summarizeBuckets(activityIntervals, prepared.originMs, bucketSeconds),
  };
}

export function minettiCost(grade) {
  const bounded = clamp(grade, -MAX_ABSOLUTE_GRADE, MAX_ABSOLUTE_GRADE);
  return (155.4 * bounded ** 5)
    - (30.4 * bounded ** 4)
    - (43.3 * bounded ** 3)
    + (46.3 * bounded ** 2)
    + (19.5 * bounded)
    + 3.6;
}

function prepareGapIntervals(records) {
  const points = records
    .map((record) => normalizePoint(record))
    .filter((point) => point.timeMs != null && point.distanceMeters != null)
    .sort((a, b) => a.timeMs - b.timeMs);

  if (points.length < 2) return { intervals: [], originMs: null, gradeSource: "unavailable" };

  const tracks = splitTracks(points);
  let elevationGradeCount = 0;
  let fitGradeCount = 0;

  for (const track of tracks) {
    const elevationGrades = regressionGrades(track, DEFAULT_GRADE_WINDOW_METERS);
    for (let index = 0; index < track.length; index += 1) {
      const elevationGrade = elevationGrades[index];
      if (elevationGrade != null) {
        track[index].localGrade = elevationGrade;
        track[index].gradeSource = "smoothed-elevation";
        elevationGradeCount += 1;
      } else if (track[index].fitGrade != null) {
        track[index].localGrade = clamp(track[index].fitGrade, -MAX_ABSOLUTE_GRADE, MAX_ABSOLUTE_GRADE);
        track[index].gradeSource = "fit-record-grade";
        fitGradeCount += 1;
      }
    }
  }

  const intervals = [];
  for (const track of tracks) {
    for (let index = 1; index < track.length; index += 1) {
      const previous = track[index - 1];
      const current = track[index];
      const distanceMeters = current.distanceMeters - previous.distanceMeters;
      const durationSeconds = (current.timeMs - previous.timeMs) / 1000;
      if (!(distanceMeters > 0) || !(durationSeconds > 0)) continue;

      const speed = intervalSpeed(previous, current, distanceMeters, durationSeconds);
      if (speed == null) continue;

      const grades = [previous.localGrade, current.localGrade].filter(Number.isFinite);
      const grade = grades.length ? grades.reduce((sum, value) => sum + value, 0) / grades.length : null;
      const actualSeconds = distanceMeters / speed;
      const costRatio = grade == null ? null : minettiCost(grade) / minettiCost(0);
      const gapSeconds = costRatio && costRatio > 0 ? actualSeconds / costRatio : null;

      intervals.push({
        startMs: previous.timeMs,
        endMs: current.timeMs,
        midpointMs: previous.timeMs + ((current.timeMs - previous.timeMs) / 2),
        startDistanceMeters: previous.distanceMeters,
        endDistanceMeters: current.distanceMeters,
        midpointDistanceMeters: previous.distanceMeters + (distanceMeters / 2),
        distanceMeters,
        actualSeconds,
        gapSeconds,
        grade,
        gradeSource: grade == null ? null : (previous.gradeSource === current.gradeSource ? current.gradeSource : "mixed"),
      });
    }
  }

  return {
    intervals,
    originMs: points[0].timeMs,
    gradeSource: elevationGradeCount && fitGradeCount
      ? "smoothed-elevation-with-fit-record-fallback"
      : elevationGradeCount
        ? "smoothed-elevation"
        : fitGradeCount
          ? "fit-record-grade"
          : "unavailable",
  };
}

function summarizeDistanceWorkoutBlocks(intervals, workoutSteps) {
  if (!intervals.length || !workoutSteps.length) return [];
  const distances = workoutSteps.map((step) => {
    const type = String(pick(step, ["durationType", "duration_type"]) || "").toLowerCase();
    const distance = number(pick(step, ["durationDistance", "duration_distance"]));
    return type === "distance" && distance > 0 ? distance : null;
  });
  if (distances.some((distance) => distance == null)) return [];

  let cursor = Math.min(...intervals.map((interval) => interval.startDistanceMeters));
  return workoutSteps.map((step, index) => {
    const startDistanceMeters = cursor;
    const endDistanceMeters = startDistanceMeters + distances[index];
    cursor = endDistanceMeters;
    const selected = intervals.filter((interval) => (
      interval.midpointDistanceMeters >= startDistanceMeters
      && interval.midpointDistanceMeters < endDistanceMeters
    ));
    const metric = summarizeIntervals(selected);
    if (!metric) return null;

    return compactObject({
      index,
      messageIndex: number(pick(step, ["messageIndex", "message_index"])),
      intensity: pick(step, ["intensity"]),
      targetType: pick(step, ["targetType", "target_type"]),
      plannedDistanceMeters: distances[index],
      startDistanceMeters: round(startDistanceMeters, 1),
      endDistanceMeters: round(endDistanceMeters, 1),
      ...metric,
    });
  }).filter(Boolean);
}

function normalizePoint(record) {
  const rawFitGrade = number(pick(record, ["grade"]));
  return {
    timeMs: parseTime(pick(record, ["timestamp", "startTime", "start_time"])),
    distanceMeters: number(pick(record, ["distance"])),
    elevationMeters: number(pick(record, ["enhancedAltitude", "enhanced_altitude", "altitude"])),
    speedMetersPerSecond: number(pick(record, ["enhancedSpeed", "enhanced_speed", "speed"])),
    fitGrade: rawFitGrade == null ? null : rawFitGrade / 100,
    localGrade: null,
    gradeSource: null,
  };
}

function splitTracks(points) {
  const tracks = [];
  let current = [];
  let previous = null;

  for (const point of points) {
    const distanceReset = previous && point.distanceMeters < previous.distanceMeters - 1;
    if (distanceReset && current.length) {
      tracks.push(current);
      current = [];
    }
    current.push(point);
    previous = point;
  }
  if (current.length) tracks.push(current);
  return tracks;
}

function regressionGrades(points, windowMeters) {
  const output = Array(points.length).fill(null);
  if (!points.length) return output;

  const count = [0];
  const distanceSum = [0];
  const elevationSum = [0];
  const distanceElevationSum = [0];
  const squaredDistanceSum = [0];
  for (const point of points) {
    const hasElevation = point.elevationMeters != null;
    const sampleCount = hasElevation ? 1 : 0;
    const distance = hasElevation ? point.distanceMeters : 0;
    const elevation = hasElevation ? point.elevationMeters : 0;
    count.push(count.at(-1) + sampleCount);
    distanceSum.push(distanceSum.at(-1) + distance);
    elevationSum.push(elevationSum.at(-1) + elevation);
    distanceElevationSum.push(distanceElevationSum.at(-1) + (distance * elevation));
    squaredDistanceSum.push(squaredDistanceSum.at(-1) + (distance ** 2));
  }

  const radius = windowMeters / 2;
  let left = 0;
  let right = -1;
  for (let index = 0; index < points.length; index += 1) {
    const center = points[index].distanceMeters;
    while (left < points.length && points[left].distanceMeters < center - radius) left += 1;
    while (right + 1 < points.length && points[right + 1].distanceMeters <= center + radius) right += 1;

    const sampleCount = rangeSum(count, left, right);
    if (sampleCount < 3 || points[right].distanceMeters - points[left].distanceMeters < MIN_GRADE_SPAN_METERS) continue;

    const sumDistance = rangeSum(distanceSum, left, right);
    const sumElevation = rangeSum(elevationSum, left, right);
    const sumDistanceElevation = rangeSum(distanceElevationSum, left, right);
    const sumSquaredDistance = rangeSum(squaredDistanceSum, left, right);
    const numerator = sumDistanceElevation - ((sumDistance * sumElevation) / sampleCount);
    const denominator = sumSquaredDistance - ((sumDistance ** 2) / sampleCount);
    if (denominator > 0) output[index] = clamp(numerator / denominator, -MAX_ABSOLUTE_GRADE, MAX_ABSOLUTE_GRADE);
  }
  return output;
}

function rangeSum(prefix, left, right) {
  return prefix[right + 1] - prefix[left];
}

function intervalSpeed(previous, current, distanceMeters, durationSeconds) {
  const recorded = [previous.speedMetersPerSecond, current.speedMetersPerSecond]
    .filter(isRunningSpeed);
  if (recorded.length) return recorded.reduce((sum, value) => sum + value, 0) / recorded.length;

  const derived = distanceMeters / durationSeconds;
  return durationSeconds <= 15 && isRunningSpeed(derived) ? derived : null;
}

function summarizeSegment(intervals, segment, index) {
  const range = segmentRange(segment);
  const selected = range ? intervals.filter((interval) => intervalInRange(interval, range)) : [];
  const metric = summarizeIntervals(selected);
  if (!metric) return null;

  return compactObject({
    index,
    startTime: range?.startMs != null ? new Date(range.startMs).toISOString() : null,
    endTime: range?.endMs != null ? new Date(range.endMs).toISOString() : null,
    declaredDistanceMeters: number(pick(segment, ["totalDistance", "total_distance"])),
    ...metric,
  });
}

function summarizeIntervals(intervals) {
  const paceSupported = intervals.filter((interval) => interval.actualSeconds != null);
  const gapSupported = paceSupported.filter((interval) => interval.gapSeconds != null);
  const supportedDistance = paceSupported.reduce((sum, interval) => sum + interval.distanceMeters, 0);
  const gapDistance = gapSupported.reduce((sum, interval) => sum + interval.distanceMeters, 0);
  if (gapDistance < MIN_REPORT_DISTANCE_METERS || !(supportedDistance > 0)) return null;

  const actualSeconds = gapSupported.reduce((sum, interval) => sum + interval.actualSeconds, 0);
  const flatEquivalentSeconds = gapSupported.reduce((sum, interval) => sum + interval.gapSeconds, 0);
  const averageGrade = gapSupported.reduce((sum, interval) => sum + (interval.grade * interval.distanceMeters), 0) / gapDistance;
  const sources = new Set(gapSupported.map((interval) => interval.gradeSource).filter(Boolean));

  return {
    source: "app-estimated",
    algorithmVersion: GAP_ALGORITHM_VERSION,
    distanceMeters: round(gapDistance, 1),
    rawPaceSecondsPerKm: round((actualSeconds / gapDistance) * 1000, 1),
    gapSecondsPerKm: round((flatEquivalentSeconds / gapDistance) * 1000, 1),
    averageLocalGradePercent: round(averageGrade * 100, 2),
    gradeCoveragePercent: round((gapDistance / supportedDistance) * 100, 1),
    sampleCount: gapSupported.length,
    gradeSource: sources.size === 1 ? [...sources][0] : "mixed",
  };
}

function summarizeBuckets(intervals, originMs, bucketSeconds) {
  if (originMs == null || !(bucketSeconds > 0)) return [];
  const buckets = new Map();
  for (const interval of intervals) {
    const index = Math.max(0, Math.floor((interval.midpointMs - originMs) / (bucketSeconds * 1000)));
    if (!buckets.has(index)) buckets.set(index, []);
    buckets.get(index).push(interval);
  }

  return [...buckets.entries()]
    .map(([index, bucket]) => {
      const metric = summarizeIntervalsWithMinimum(bucket, 1);
      return metric ? {
        elapsedSeconds: index * bucketSeconds,
        gapSecondsPerKm: metric.gapSecondsPerKm,
        gradeCoveragePercent: metric.gradeCoveragePercent,
      } : null;
    })
    .filter(Boolean);
}

function summarizeIntervalsWithMinimum(intervals, minimumDistanceMeters) {
  const paceSupported = intervals.filter((interval) => interval.actualSeconds != null);
  const gapSupported = paceSupported.filter((interval) => interval.gapSeconds != null);
  const supportedDistance = paceSupported.reduce((sum, interval) => sum + interval.distanceMeters, 0);
  const gapDistance = gapSupported.reduce((sum, interval) => sum + interval.distanceMeters, 0);
  if (gapDistance < minimumDistanceMeters || !(supportedDistance > 0)) return null;
  const flatEquivalentSeconds = gapSupported.reduce((sum, interval) => sum + interval.gapSeconds, 0);
  return {
    gapSecondsPerKm: round((flatEquivalentSeconds / gapDistance) * 1000, 1),
    gradeCoveragePercent: round((gapDistance / supportedDistance) * 100, 1),
  };
}

function segmentRange(segment) {
  const startMs = parseTime(pick(segment, ["startTime", "start_time"]));
  let endMs = parseTime(pick(segment, ["timestamp", "endTime", "end_time"]));
  if (startMs == null) return null;
  if (endMs == null || endMs <= startMs) {
    const elapsedSeconds = number(pick(segment, ["totalElapsedTime", "total_elapsed_time", "totalTimerTime", "total_timer_time"]));
    if (elapsedSeconds != null && elapsedSeconds > 0) endMs = startMs + (elapsedSeconds * 1000);
  }
  return { startMs, endMs: endMs != null && endMs > startMs ? endMs : Infinity };
}

function intervalInRange(interval, range) {
  return interval.midpointMs >= range.startMs && interval.midpointMs <= range.endMs;
}

function rangesOverlap(first, second) {
  return first.startMs <= second.endMs && second.startMs <= first.endMs;
}

function isRunningSport(value) {
  return String(value || "").toLowerCase().includes("run");
}

function isRunningSpeed(value) {
  return Number.isFinite(value)
    && value >= MIN_RUNNING_SPEED_METERS_PER_SECOND
    && value <= MAX_RUNNING_SPEED_METERS_PER_SECOND;
}

function parseTime(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function pick(object, keys) {
  for (const key of keys) {
    if (object?.[key] !== undefined && object[key] !== null) return object[key];
  }
  return null;
}

function number(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined));
}
