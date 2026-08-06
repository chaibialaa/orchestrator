<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{ health: any; busy: boolean }>();
const emit = defineEmits<{ (event: "refresh"): void }>();

const numbers = new Intl.NumberFormat("en");
const count = (value: unknown) => numbers.format(Number(value) || 0);
const bytes = (value: unknown) => {
  const size = Number(value);
  if (value == null || Number.isNaN(size)) return "Unknown size";
  if (size < 1024) return `${size} B`;
  if (size < 1048576) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1073741824) return `${(size / 1048576).toFixed(1)} MB`;
  return `${(size / 1073741824).toFixed(2)} GB`;
};
const date = (value: unknown, fallback = "Never recorded") => {
  if (!value) return fallback;
  const stamp = new Date(String(value));
  return Number.isNaN(stamp.getTime())
    ? fallback
    : stamp.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
};
const isoStamp = (value: unknown) => {
  if (!value) return undefined;
  const stamp = new Date(String(value));
  return Number.isNaN(stamp.getTime()) ? undefined : stamp.toISOString();
};

const database = computed(() => props.health?.database || null);
const activity = computed(() => props.health?.activity || null);
const evidence = computed(() => props.health?.evidence || null);
const backups = computed<any[]>(() =>
  Array.isArray(props.health?.backups) ? props.health.backups : [],
);
const integrity = computed(() => String(database.value?.integrity ?? ""));
const integrityOk = computed(() => integrity.value === "ok");
const foreignKeyViolations = computed(
  () => Number(database.value?.foreign_key_violations) || 0,
);
const evidenceDebt = computed(
  () =>
    (Number(evidence.value?.missing) || 0) +
    (Number(evidence.value?.unhashed) || 0),
);
const evidenceCoverage = computed(() => {
  const total = Number(evidence.value?.total) || 0;
  if (!total) return 0;
  return Math.round(((Number(evidence.value?.available_hashed) || 0) / total) * 100);
});
const registerOk = computed(
  () => integrityOk.value && foreignKeyViolations.value === 0,
);
const tone = computed(() => {
  if (!props.health) return "unknown";
  if (!registerOk.value) return "alert";
  return evidenceDebt.value ? "watch" : "ok";
});
const statusLabel = computed(() =>
  ({
    unknown: "Not checked",
    alert: "Needs attention",
    watch: "Evidence debt",
    ok: "Healthy",
  })[tone.value],
);
const liveMessage = computed(() => {
  if (props.busy) return "Re-reading the register health checks.";
  if (!props.health) return "No health check has been read yet.";
  return `Register ${registerOk.value ? "consistent" : "inconsistent"}. Integrity ${
    integrity.value || "unknown"
  }, ${count(foreignKeyViolations.value)} foreign-key violations, ${count(
    evidenceDebt.value,
  )} evidence records missing or unhashed, ${count(backups.value.length)} backup files detected. Checked ${date(
    props.health?.generated_at,
    "at an unknown time",
  )}.`;
});
const metrics = computed(() => [
  {
    key: "integrity",
    label: "SQLite integrity",
    value: integrity.value ? (integrityOk.value ? "OK" : "Issue") : "Unknown",
    note: integrity.value ? `PRAGMA integrity_check: ${integrity.value}` : "Not reported",
    tone: integrity.value ? (integrityOk.value ? "ok" : "alert") : "unknown",
  },
  {
    key: "foreign-keys",
    label: "Foreign-key violations",
    value: count(foreignKeyViolations.value),
    note: foreignKeyViolations.value ? "Referential links are broken" : "All references resolve",
    tone: foreignKeyViolations.value ? "alert" : "ok",
  },
  {
    key: "evidence-debt",
    label: "Evidence debt",
    value: count(evidenceDebt.value),
    note: `${count(evidence.value?.missing)} missing · ${count(evidence.value?.unhashed)} unhashed`,
    tone: evidenceDebt.value ? "watch" : "ok",
  },
  {
    key: "backups",
    label: "Detected backups",
    value: count(backups.value.length),
    note: backups.value.length ? `Latest ${date(backups.value[0]?.modified_at)}` : "None beside the database",
    tone: backups.value.length ? "ok" : "watch",
  },
]);
</script>

<template>
  <section class="sh-root" aria-labelledby="sh-title">
    <header class="sh-head">
      <div class="sh-head-main">
        <p class="sh-eyebrow">Register integrity · read-only</p>
        <h2 id="sh-title">System health</h2>
        <p class="sh-sub">
          Stored state of the persistent register, its evidence manifests and the
          backup files that sit beside it.
        </p>
      </div>
      <div class="sh-head-side">
        <span class="sh-badge" :data-tone="tone">
          <span class="sh-visually-hidden">Overall register status:</span>
          {{ statusLabel }}
        </span>
        <button
          class="sh-refresh"
          type="button"
          :disabled="busy"
          :aria-busy="busy"
          @click="emit('refresh')"
        >
          {{ busy ? "Reading checks…" : "Re-read checks" }}
        </button>
      </div>
    </header>

    <p class="sh-live" role="status" aria-live="polite">{{ liveMessage }}</p>

    <p v-if="!health" class="sh-empty">
      No health record is loaded. Re-read the checks to display the stored
      register state.
    </p>

    <template v-else>
      <ul class="sh-metrics">
        <li v-for="metric in metrics" :key="metric.key" class="sh-metric" :data-tone="metric.tone">
          <span class="sh-metric-label">{{ metric.label }}</span>
          <strong class="sh-metric-value">{{ metric.value }}</strong>
          <small class="sh-metric-note">{{ metric.note }}</small>
        </li>
      </ul>

      <div class="sh-columns">
        <section class="sh-card" aria-labelledby="sh-database-title">
          <h3 id="sh-database-title" class="sh-card-title">Database file</h3>
          <dl class="sh-facts">
            <div class="sh-fact">
              <dt>Database size</dt>
              <dd>{{ bytes(database?.bytes) }}</dd>
            </div>
            <div class="sh-fact">
              <dt>Write-ahead log</dt>
              <dd>{{ bytes(database?.wal_bytes) }}</dd>
            </div>
            <div class="sh-fact">
              <dt>Schema version</dt>
              <dd>{{ database?.schema_version ?? "Unknown" }}</dd>
            </div>
            <div class="sh-fact">
              <dt>Integrity check</dt>
              <dd>
                <span class="sh-pill" :data-tone="integrityOk ? 'ok' : 'alert'">{{
                  integrity || "unknown"
                }}</span>
              </dd>
            </div>
            <div class="sh-fact">
              <dt>Foreign-key violations</dt>
              <dd>
                <span class="sh-pill" :data-tone="foreignKeyViolations ? 'alert' : 'ok'">{{
                  count(foreignKeyViolations)
                }}</span>
              </dd>
            </div>
            <div class="sh-fact">
              <dt>File last modified</dt>
              <dd>
                <time :datetime="isoStamp(database?.modified_at)">{{
                  date(database?.modified_at, "Unknown")
                }}</time>
              </dd>
            </div>
            <div class="sh-fact sh-fact-wide">
              <dt>Database path</dt>
              <dd><code class="sh-path">{{ database?.path || "Unknown path" }}</code></dd>
            </div>
          </dl>
        </section>

        <section class="sh-card" aria-labelledby="sh-activity-title">
          <h3 id="sh-activity-title" class="sh-card-title">Latest recorded activity</h3>
          <dl class="sh-facts">
            <div class="sh-fact sh-fact-wide">
              <dt>Last event</dt>
              <dd>
                <time :datetime="isoStamp(activity?.last_event_at)">{{
                  date(activity?.last_event_at, "No event recorded")
                }}</time>
              </dd>
            </div>
            <div class="sh-fact sh-fact-wide">
              <dt>Summary</dt>
              <dd class="sh-summary">{{ activity?.last_summary || "No summary stored" }}</dd>
            </div>
          </dl>
          <h3 class="sh-card-title sh-card-title-second">Evidence manifests</h3>
          <dl class="sh-facts">
            <div class="sh-fact">
              <dt>Total records</dt>
              <dd>{{ count(evidence?.total) }}</dd>
            </div>
            <div class="sh-fact">
              <dt>Available and hashed</dt>
              <dd>{{ count(evidence?.available_hashed) }}</dd>
            </div>
            <div class="sh-fact">
              <dt>Unhashed</dt>
              <dd :class="{ 'sh-warn': Number(evidence?.unhashed) > 0 }">
                {{ count(evidence?.unhashed) }}
              </dd>
            </div>
            <div class="sh-fact">
              <dt>Missing</dt>
              <dd :class="{ 'sh-warn': Number(evidence?.missing) > 0 }">
                {{ count(evidence?.missing) }}
              </dd>
            </div>
          </dl>
          <p class="sh-coverage-label">
            {{ evidenceCoverage }}% of evidence records are available and hashed
          </p>
          <div class="sh-bar" aria-hidden="true">
            <i :style="{ width: `${evidenceCoverage}%` }"></i>
          </div>
        </section>
      </div>

      <section class="sh-card" aria-labelledby="sh-backups-title">
        <div class="sh-card-head">
          <h3 id="sh-backups-title" class="sh-card-title">Backup inventory</h3>
          <span class="sh-card-note">
            {{ backups.length }} adjacent database {{ backups.length === 1 ? "file" : "files" }}
          </span>
        </div>
        <p v-if="!backups.length" class="sh-empty">
          No named backup file was detected beside the active database.
        </p>
        <div
          v-else
          class="sh-table-scroll"
          role="region"
          aria-labelledby="sh-backups-title"
          tabindex="0"
        >
          <table class="sh-table">
            <caption class="sh-visually-hidden">
              Backup database files detected beside the active database, newest first
            </caption>
            <thead>
              <tr>
                <th scope="col">File</th>
                <th scope="col">Size</th>
                <th scope="col">Last modified</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="backup in backups" :key="backup.path">
                <th scope="row">
                  <span class="sh-file-name">{{ backup.name }}</span>
                  <code class="sh-path">{{ backup.path }}</code>
                </th>
                <td>{{ bytes(backup.bytes) }}</td>
                <td>
                  <time :datetime="isoStamp(backup.modified_at)">{{
                    date(backup.modified_at, "Unknown")
                  }}</time>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <footer class="sh-footer">
        <p class="sh-boundary">
          <strong>Observation only.</strong>
          Orchestrator reads and stores this state. This panel never repairs,
          vacuums, backs up, restores or deletes anything, and it never executes
          project work. Every value shown here is a stored measurement.
        </p>
        <dl class="sh-stamps">
          <div class="sh-fact">
            <dt>Checked at</dt>
            <dd>
              <time :datetime="isoStamp(health?.generated_at)">{{
                date(health?.generated_at, "Unknown")
              }}</time>
            </dd>
          </div>
          <div class="sh-fact">
            <dt>Database modified</dt>
            <dd>
              <time :datetime="isoStamp(database?.modified_at)">{{
                date(database?.modified_at, "Unknown")
              }}</time>
            </dd>
          </div>
          <div class="sh-fact">
            <dt>Last event</dt>
            <dd>
              <time :datetime="isoStamp(activity?.last_event_at)">{{
                date(activity?.last_event_at, "No event recorded")
              }}</time>
            </dd>
          </div>
        </dl>
      </footer>
    </template>
  </section>
</template>

<style>
@import "../system-health.css";
</style>
